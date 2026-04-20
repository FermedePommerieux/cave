/*
 * cave_saucisson.js
 * Script Shelly unique pour régulation cave à saucissons.
 * Architecture à états: air cave + plaque de condensation.
 */

var CONFIG = {
  mqttPrefix: "fdp_communs_cave_saucissons",
  haObjectId: "cave_saucisson",

  localAirTempSensorId: 100,
  localPlateTempSensorId: 101,

  coolSwitchId: 0,
  heatSwitchId: 1,

  externalTempTopic: "fdp_communs_cave_saucissons/thermostat/external_temperature",
  externalHumidityTopic: "fdp_communs_cave_saucissons/thermostat/external_humidity",

  tempStaleS: 900,
  humidityStaleS: 10800,

  defaultEnabled: true,
  defaultTempSetpointC: 12.0,
  defaultHumiditySetpointRh: 78.0,
  humiditySetpointHysteresisRh: 3.0,
  humiditySetpointMinRh: 60.0,
  humiditySetpointMaxRh: 90.0,

  hardMaxAirC: 14.0,
  dryingResumeBelowHardMaxC: 13.5,

  coolOnC: 13.0,
  coolOffC: 11.5,
  lockoutS: 180,

  heatOnC: 10.5,
  heatOffC: 11.5,
  heatDisableAboveC: 13.5,

  // Consigne air dédiée mode DRYING_ACTIVE (hystérésis symétrique).
  dryingAirSetpointC: 12.0,
  dryingAirHysteresisC: 0.6,

  plateMinOffC: 0.0,
  plateMinResumeC: 3.0,

  dewTargetMarginC: 1.0,
  plateTargetHysteresisC: 0.6,
  dewPointTempSource: "local_air", // "local_air" | "external_if_fresh"

  adaptiveCoolMaxInitialS: 240,
  adaptiveCoolMaxMinS: 120,
  adaptiveCoolMaxMaxS: 480,
  adaptiveCoolOvershootStepDownS: 30,

  // Fin inertie: timeout dur, rebond rapide ou stabilité des minima.
  inertiaMaxS: 420,
  inertiaRiseFinishDeltaC: 0.2,
  postCoolMinDeltaC: 0.05,
  postCoolStableWindowS: 60,

  loopMs: 5000,
  mqttPublishMs: 5000,
  // Discovery HA allégé par défaut pour limiter RAM/CPU au boot Shelly.
  discoveryExtendedEnabled: false,
  // Mode léger dédié condensation en discovery minimal.
  discoveryCondensationDiagnosticsEnabled: true,
  // Migration discovery HA: debug optionnel des payloads envoyés (coûteux en mémoire).
  discoveryDebugEnabled: false,
  discoveryDebugTopicSuffix: "debug/discovery_payload",

  // Fenêtre glissante (approchée) pour diagnostiquer l'efficacité de condensation.
  condensingRecentWindowS: 1800,
  dryingIneffectiveMinCompressorS: 600,
  dryingIneffectiveMinCondensingPct: 25
};

var MACHINE = {
  IDLE: "IDLE",
  COOLING: "COOLING",
  POST_COOL_INERTIA: "POST_COOL_INERTIA",
  HEATING: "HEATING",
  DRYING_ACTIVE: "DRYING_ACTIVE",
  FAULT: "FAULT"
};

var STATE = {
  enabled: CONFIG.defaultEnabled,
  tempSetpointC: CONFIG.defaultTempSetpointC,
  humiditySetpointRh: CONFIG.defaultHumiditySetpointRh,
  humiditySetpointEffectiveRh: CONFIG.defaultHumiditySetpointRh,

  externalTempC: null,
  externalTempTs: 0,
  externalHumidityRh: null,
  externalHumidityTs: 0,

  coolOn: false,
  heatOn: false,

  machineState: MACHINE.IDLE,
  coolReason: "none",
  heatReason: "none",
  cycleStopReason: "none",
  lastPlateEvent: "none",
  lastPostCoolFinalizeReason: "none",

  coolingLockoutUntil: 0,
  coolingStartedAt: 0,
  learnedCoolMaxS: CONFIG.adaptiveCoolMaxInitialS,
  learnedCoolReady: false,

  plateTooColdLatch: false,
  dryingOvertempSuspend: false,

  postCoolActive: false,
  postCoolStartedAt: 0,
  postCoolTargetC: null,
  postCoolMinC: null,
  postCoolLastMeaningfulMinAt: 0,
  postCoolLastC: null,
  lastPostCoolMinC: null,
  lastOvershootC: null,

  lastFaultCode: "none",
  lastPublishedAt: 0,
  lastDecision: "startup",

  compressorStarts: 0,
  condensingTotalS: 0,
  dryingActiveTotalS: 0,
  recentWindowTotalS: 0,
  recentWindowCondensingS: 0,
  recentDryingCompressorS: 0,
  recentDryingCondensingS: 0,
  dryingIneffective: false,
  dryingIneffectiveReason: "none",
  lastLoopTs: 0
};

function nowS() {
  var sys = Shelly.getComponentStatus("sys");
  if (sys && typeof sys.unixtime === "number" && sys.unixtime > 0) {
    return sys.unixtime;
  }
  return Math.floor(Date.now() / 1000);
}

function isFiniteNumber(v) {
  return typeof v === "number" && isFinite(v);
}

function readTempC(sensorId) {
  var st = Shelly.getComponentStatus("temperature:" + sensorId);
  if (!st) return null;
  if (isFiniteNumber(st.tC)) return st.tC;
  if (isFiniteNumber(st.value)) return st.value;
  return null;
}

function parseNumericPayload(payload) {
  if (typeof payload === "number") return payload;
  if (typeof payload !== "string") return null;
  var n = Number(payload);
  if (!isFiniteNumber(n)) return null;
  return n;
}

function mqttPublish(subTopic, obj) {
  if (typeof MQTT === "undefined") return;
  var fullTopic = CONFIG.mqttPrefix + "/" + CONFIG.haObjectId + "/" + subTopic;
  MQTT.publish(fullTopic, JSON.stringify(obj), 0, false);
}

function mqttPublishRetained(topic, obj) {
  if (typeof MQTT === "undefined") return;
  MQTT.publish(topic, JSON.stringify(obj), 0, true);
}

function mqttPublishRetainedEmpty(topic) {
  if (typeof MQTT === "undefined") return;
  // Payload retained vide => suppression retained côté broker.
  MQTT.publish(topic, "", 0, true);
}

function publishDiscoveryDebug(action, topic, payload) {
  if (typeof MQTT === "undefined" || !CONFIG.discoveryDebugEnabled) return;
  var fullTopic = CONFIG.mqttPrefix + "/" + CONFIG.haObjectId + "/" + CONFIG.discoveryDebugTopicSuffix;
  MQTT.publish(fullTopic, JSON.stringify({
    action: action,
    discovery_topic: topic,
    payload: payload,
    ts: nowS()
  }), 0, false);
}

function discoveryTopic(component, entityKey) {
  return "homeassistant/" + component + "/" + CONFIG.haObjectId + "_" + entityKey + "/config";
}

var DISCOVERY_MINIMAL_ENTITIES = [
  { component: "humidifier", key: "humidifier" },
  { component: "sensor", key: "air_temperature" },
  { component: "sensor", key: "plate_temperature" },
  { component: "sensor", key: "humidity" },
  { component: "sensor", key: "machine_state" },
  { component: "sensor", key: "fault" }
];

var DISCOVERY_EXTENDED_ONLY_ENTITIES = [
  { component: "sensor", key: "control_temperature" },
  { component: "sensor", key: "dew_temp_source" },
  { component: "sensor", key: "dew_point" },
  { component: "sensor", key: "plate_target" },
  { component: "sensor", key: "plate_minus_dew" },
  { component: "sensor", key: "condensing_margin" },
  { component: "sensor", key: "condensing_recent_percent" },
  { component: "sensor", key: "condensing_total" },
  { component: "sensor", key: "drying_active_total" },
  { component: "sensor", key: "drying_compressor_starts" },
  { component: "sensor", key: "target_humidity" },
  { component: "sensor", key: "learned_max_runtime" },
  { component: "sensor", key: "overshoot" },
  { component: "sensor", key: "lockout_remaining" },
  { component: "sensor", key: "last_min_plate_after_stop" },
  { component: "sensor", key: "cool_reason" },
  { component: "sensor", key: "heat_reason" },
  { component: "sensor", key: "drying_block_reason" },
  { component: "sensor", key: "humidity_mode" },
  { component: "binary_sensor", key: "post_cool_active" },
  { component: "binary_sensor", key: "plate_too_cold_latch" },
  { component: "binary_sensor", key: "drying_overtemp_suspend" },
  { component: "binary_sensor", key: "humidity_control_available" },
  { component: "binary_sensor", key: "drying_mode_requested" },
  { component: "binary_sensor", key: "condensing_now" },
  { component: "binary_sensor", key: "drying_ineffective" },
  // Ancienne entité historique à purger.
  { component: "climate", key: "climate" }
];

var DISCOVERY_CONDENSATION_DIAG_ENTITIES = [
  { component: "sensor", key: "dew_point" },
  { component: "sensor", key: "plate_target" },
  { component: "sensor", key: "plate_minus_dew" },
  { component: "sensor", key: "cool_reason" },
  { component: "sensor", key: "drying_block_reason" },
  { component: "binary_sensor", key: "condensing_now" }
];

function purgeDiscoveryEntityList(entities) {
  var i;
  for (i = 0; i < entities.length; i++) {
    var topic = discoveryTopic(entities[i].component, entities[i].key);
    mqttPublishRetainedEmpty(topic);
    publishDiscoveryDebug("purge", topic, null);
  }
}

function purgeDiscoveryConfigs() {
  // Purge minimal + héritage étendu/legacy pour éviter les entités fantômes.
  purgeDiscoveryEntityList(DISCOVERY_MINIMAL_ENTITIES);
  purgeDiscoveryEntityList(DISCOVERY_EXTENDED_ONLY_ENTITIES);
  purgeDiscoveryEntityList(DISCOVERY_CONDENSATION_DIAG_ENTITIES);
}

function haDeviceInfo() {
  return {
    identifiers: [CONFIG.haObjectId],
    name: "Cave Saucisson Controller",
    manufacturer: "Custom",
    model: "Shelly Script"
  };
}

function publishDiscoveryConfig(component, entityKey, payload) {
  var topic = discoveryTopic(component, entityKey);
  var merged = {
    unique_id: CONFIG.haObjectId + "_" + entityKey,
    device: haDeviceInfo()
  };
  var k;
  for (k in payload) {
    if (typeof payload[k] !== "undefined" && payload[k] !== null) {
      merged[k] = payload[k];
    }
  }
  publishDiscoveryDebug("publish", topic, merged);
  mqttPublishRetained(topic, merged);
}

function publishAllDiscoveryConfigs() {
  var stateTopic = CONFIG.mqttPrefix + "/" + CONFIG.haObjectId + "/state";
  var baseTopic = CONFIG.mqttPrefix + "/" + CONFIG.haObjectId;

  publishDiscoveryConfig("humidifier", "humidifier", {
    name: "Cave Dehumidifier",
    device_class: "dehumidifier",
    state_topic: stateTopic,
    state_value_template: "{% if value_json.enabled %}ON{% else %}OFF{% endif %}",
    command_topic: baseTopic + "/set/mode",
    payload_on: "auto",
    payload_off: "off",
    mode_state_topic: stateTopic,
    mode_state_template: "{% if value_json.enabled %}auto{% else %}off{% endif %}",
    mode_command_topic: baseTopic + "/set/mode",
    modes: ["off", "auto"],
    current_humidity_topic: stateTopic,
    current_humidity_template: "{{ value_json.humidity_rh }}",
    target_humidity_state_topic: stateTopic,
    target_humidity_state_template: "{{ value_json.target_humidity_rh }}",
    target_humidity_command_topic: baseTopic + "/set/target_humidity"
  });

  // Discovery minimal (défaut): entités strictement essentielles pour limiter la mémoire.
  publishDiscoveryConfig("sensor", "air_temperature", {
    name: "Cave Air Temperature",
    state_topic: stateTopic,
    value_template: "{{ value_json.air_c | default(none) }}",
    device_class: "temperature",
    unit_of_measurement: "°C"
  });

  publishDiscoveryConfig("sensor", "plate_temperature", {
    name: "Cave Plate Temperature",
    state_topic: stateTopic,
    value_template: "{{ value_json.plate_c | default(none) }}",
    device_class: "temperature",
    unit_of_measurement: "°C"
  });

  publishDiscoveryConfig("sensor", "humidity", {
    name: "Cave Humidity",
    state_topic: stateTopic,
    value_template: "{{ value_json.humidity_rh | default(none) }}",
    device_class: "humidity",
    unit_of_measurement: "%"
  });

  publishDiscoveryConfig("sensor", "machine_state", {
    name: "Cave Machine State",
    state_topic: stateTopic,
    value_template: "{{ value_json.machine_state | default(none) }}"
  });

  publishDiscoveryConfig("sensor", "fault", {
    name: "Cave Fault",
    state_topic: stateTopic,
    value_template: "{{ value_json.fault | default(none) }}"
  });

  if (CONFIG.discoveryCondensationDiagnosticsEnabled) {
    publishDiscoveryConfig("sensor", "dew_point", {
      name: "Cave Dew Point",
      state_topic: stateTopic,
      value_template: "{{ value_json.dew_point_c | default(none) }}",
      device_class: "temperature",
      unit_of_measurement: "°C"
    });

    publishDiscoveryConfig("sensor", "plate_target", {
      name: "Cave Plate Target",
      state_topic: stateTopic,
      value_template: "{{ value_json.plate_target_c | default(none) }}",
      device_class: "temperature",
      unit_of_measurement: "°C"
    });

    publishDiscoveryConfig("sensor", "plate_minus_dew", {
      name: "Cave Plate Minus Dew",
      state_topic: stateTopic,
      value_template: "{{ value_json.plate_minus_dew_c | default(none) }}",
      unit_of_measurement: "°C"
    });

    publishDiscoveryConfig("sensor", "cool_reason", {
      name: "Cave Cool Reason",
      state_topic: stateTopic,
      value_template: "{{ value_json.cool_reason | default(none) }}"
    });

    publishDiscoveryConfig("sensor", "drying_block_reason", {
      name: "Cave Drying Block Reason",
      state_topic: stateTopic,
      value_template: "{{ value_json.drying_block_reason | default(none) }}"
    });

    publishDiscoveryConfig("binary_sensor", "condensing_now", {
      name: "Cave Condensing Now",
      state_topic: stateTopic,
      value_template: "{{ value_json.condensing_now | string | lower }}",
      payload_on: "true",
      payload_off: "false"
    });
  }

  if (!CONFIG.discoveryExtendedEnabled) return;

  // Mode étendu optionnel: visibilité diagnostics complète, plus coûteuse en mémoire.
  publishDiscoveryConfig("sensor", "control_temperature", {
    name: "Cave Control Temperature",
    state_topic: stateTopic,
    value_template: "{{ value_json.control_temp_c | default(none) }}",
    device_class: "temperature",
    unit_of_measurement: "°C"
  });

  publishDiscoveryConfig("sensor", "dew_temp_source", {
    name: "Cave Dew Temp Source",
    state_topic: stateTopic,
    value_template: "{{ value_json.dew_temp_source | default(none) }}"
  });

  publishDiscoveryConfig("sensor", "dew_point", {
    name: "Cave Dew Point",
    state_topic: stateTopic,
    value_template: "{{ value_json.dew_point_c | default(none) }}",
    device_class: "temperature",
    unit_of_measurement: "°C"
  });

  publishDiscoveryConfig("sensor", "plate_target", {
    name: "Cave Plate Target",
    state_topic: stateTopic,
    value_template: "{{ value_json.plate_target_c | default(none) }}",
    device_class: "temperature",
    unit_of_measurement: "°C"
  });

  publishDiscoveryConfig("sensor", "plate_minus_dew", {
    name: "Cave Plate Minus Dew",
    state_topic: stateTopic,
    value_template: "{{ value_json.plate_minus_dew_c | default(none) }}",
    unit_of_measurement: "°C"
  });

  publishDiscoveryConfig("sensor", "condensing_margin", {
    name: "Cave Condensing Margin",
    state_topic: stateTopic,
    value_template: "{{ value_json.condensing_margin_c | default(none) }}",
    unit_of_measurement: "°C"
  });

  publishDiscoveryConfig("sensor", "condensing_recent_percent", {
    name: "Cave Condensing Recent Percent",
    state_topic: stateTopic,
    value_template: "{{ value_json.condensing_recent_percent | default(none) }}",
    unit_of_measurement: "%"
  });

  publishDiscoveryConfig("sensor", "condensing_total", {
    name: "Cave Condensing Total",
    state_topic: stateTopic,
    value_template: "{{ value_json.condensing_total_s | default(none) }}",
    device_class: "duration",
    unit_of_measurement: "s"
  });

  publishDiscoveryConfig("sensor", "drying_active_total", {
    name: "Cave Drying Active Total",
    state_topic: stateTopic,
    value_template: "{{ value_json.drying_active_total_s | default(none) }}",
    device_class: "duration",
    unit_of_measurement: "s"
  });

  publishDiscoveryConfig("sensor", "drying_compressor_starts", {
    name: "Cave Compressor Starts",
    state_topic: stateTopic,
    value_template: "{{ value_json.compressor_starts | default(none) }}"
  });

  publishDiscoveryConfig("sensor", "target_humidity", {
    name: "Cave Target Humidity",
    state_topic: stateTopic,
    value_template: "{{ value_json.target_humidity_rh | default(none) }}",
    device_class: "humidity",
    unit_of_measurement: "%"
  });

  publishDiscoveryConfig("sensor", "learned_max_runtime", {
    name: "Cave Learned Max Runtime",
    state_topic: stateTopic,
    value_template: "{{ value_json.learned_max_runtime_s | default(none) }}",
    device_class: "duration",
    unit_of_measurement: "s"
  });

  publishDiscoveryConfig("sensor", "overshoot", {
    name: "Cave Plate Overshoot",
    state_topic: stateTopic,
    value_template: "{{ value_json.overshoot_c | default(none) }}",
    unit_of_measurement: "°C"
  });

  publishDiscoveryConfig("sensor", "lockout_remaining", {
    name: "Cave Lockout Remaining",
    state_topic: stateTopic,
    value_template: "{{ value_json.lockout_remaining_s | default(none) }}",
    device_class: "duration",
    unit_of_measurement: "s"
  });

  publishDiscoveryConfig("sensor", "last_min_plate_after_stop", {
    name: "Cave Last Min Plate After Stop",
    state_topic: stateTopic,
    value_template: "{{ value_json.last_min_plate_after_stop_c | default(none) }}",
    device_class: "temperature",
    unit_of_measurement: "°C"
  });

  publishDiscoveryConfig("sensor", "cool_reason", {
    name: "Cave Cool Reason",
    state_topic: stateTopic,
    value_template: "{{ value_json.cool_reason | default(none) }}"
  });

  publishDiscoveryConfig("sensor", "heat_reason", {
    name: "Cave Heat Reason",
    state_topic: stateTopic,
    value_template: "{{ value_json.heat_reason | default(none) }}"
  });

  publishDiscoveryConfig("sensor", "drying_block_reason", {
    name: "Cave Drying Block Reason",
    state_topic: stateTopic,
    value_template: "{{ value_json.drying_block_reason | default(none) }}"
  });

  publishDiscoveryConfig("sensor", "humidity_mode", {
    name: "Cave Humidity Mode",
    state_topic: stateTopic,
    value_template: "{{ value_json.humidity_mode | default(none) }}"
  });

  publishDiscoveryConfig("binary_sensor", "post_cool_active", {
    name: "Cave Post Cool Active",
    state_topic: stateTopic,
    value_template: "{{ value_json.post_cool_active | string | lower }}",
    payload_on: "true",
    payload_off: "false"
  });

  publishDiscoveryConfig("binary_sensor", "plate_too_cold_latch", {
    name: "Cave Plate Too Cold Latch",
    state_topic: stateTopic,
    value_template: "{{ value_json.plate_too_cold_latch | string | lower }}",
    payload_on: "true",
    payload_off: "false"
  });

  publishDiscoveryConfig("binary_sensor", "drying_overtemp_suspend", {
    name: "Cave Drying Overtemp Suspend",
    state_topic: stateTopic,
    value_template: "{{ value_json.drying_overtemp_suspend | string | lower }}",
    payload_on: "true",
    payload_off: "false"
  });

  publishDiscoveryConfig("binary_sensor", "humidity_control_available", {
    name: "Cave Humidity Control Available",
    state_topic: stateTopic,
    value_template: "{{ value_json.humidity_control_available | string | lower }}",
    payload_on: "true",
    payload_off: "false"
  });

  publishDiscoveryConfig("binary_sensor", "drying_mode_requested", {
    name: "Cave Drying Mode Requested",
    state_topic: stateTopic,
    value_template: "{{ value_json.drying_mode_requested | string | lower }}",
    payload_on: "true",
    payload_off: "false"
  });

  publishDiscoveryConfig("binary_sensor", "condensing_now", {
    name: "Cave Condensing Now",
    state_topic: stateTopic,
    value_template: "{{ value_json.condensing_now | string | lower }}",
    payload_on: "true",
    payload_off: "false"
  });

  publishDiscoveryConfig("binary_sensor", "drying_ineffective", {
    name: "Cave Drying Ineffective",
    state_topic: stateTopic,
    value_template: "{{ value_json.drying_ineffective | string | lower }}",
    payload_on: "true",
    payload_off: "false"
  });
}

function publishFault(code, severity, message) {
  STATE.lastFaultCode = code;
  mqttPublish("fault", {
    code: code,
    severity: severity,
    message: message,
    ts: nowS()
  });
}

function setSwitch(id, on) {
  Shelly.call("Switch.Set", { id: id, on: on });
}

function externalTempFresh(tsNow) {
  return isFiniteNumber(STATE.externalTempC) && (tsNow - STATE.externalTempTs) <= CONFIG.tempStaleS;
}

function externalHumidityFresh(tsNow) {
  return isFiniteNumber(STATE.externalHumidityRh) && (tsNow - STATE.externalHumidityTs) <= CONFIG.humidityStaleS;
}

function dewPointC(tempC, humidityRh) {
  if (!isFiniteNumber(tempC) || !isFiniteNumber(humidityRh)) return null;
  if (humidityRh <= 0 || humidityRh > 100) return null;

  // Magnus-Tetens, précis et léger pour le runtime Shelly.
  var a = 17.62;
  var b = 243.12;
  var gamma = Math.log(humidityRh / 100.0) + (a * tempC) / (b + tempC);
  return (b * gamma) / (a - gamma);
}

function clamp(v, vmin, vmax) {
  if (v < vmin) return vmin;
  if (v > vmax) return vmax;
  return v;
}

function computeDryingHeatDemand(airC) {
  var half = CONFIG.dryingAirHysteresisC / 2.0;
  var onThreshold = CONFIG.dryingAirSetpointC - half;
  var offThreshold = CONFIG.dryingAirSetpointC + half;

  if (STATE.heatOn) {
    if (airC >= offThreshold || airC >= CONFIG.heatDisableAboveC) return false;
    return true;
  }

  if (airC <= onThreshold && airC < CONFIG.heatDisableAboveC) return true;
  return false;
}

function updatePostCoolInertia(ts, plateC) {
  if (!STATE.postCoolActive) return;
  if (!isFiniteNumber(plateC)) {
    finalizePostCoolInertia("plate_missing");
    return;
  }

  if (!isFiniteNumber(STATE.postCoolMinC)) {
    STATE.postCoolMinC = plateC;
    STATE.postCoolLastMeaningfulMinAt = ts;
  } else if (plateC < STATE.postCoolMinC) {
    var dropC = STATE.postCoolMinC - plateC;
    STATE.postCoolMinC = plateC;
    if (dropC >= CONFIG.postCoolMinDeltaC) {
      STATE.postCoolLastMeaningfulMinAt = ts;
    }
  }

  var elapsed = ts - STATE.postCoolStartedAt;
  var sinceMeaningfulMin = ts - STATE.postCoolLastMeaningfulMinAt;
  var finishedByTimeout = elapsed >= CONFIG.inertiaMaxS;
  var finishedByRise = isFiniteNumber(STATE.postCoolMinC) && plateC >= (STATE.postCoolMinC + CONFIG.inertiaRiseFinishDeltaC);
  var finishedByStability = sinceMeaningfulMin >= CONFIG.postCoolStableWindowS;

  STATE.postCoolLastC = plateC;

  if (finishedByTimeout) {
    finalizePostCoolInertia("timeout");
  } else if (finishedByRise) {
    finalizePostCoolInertia("plate_rising");
  } else if (finishedByStability) {
    finalizePostCoolInertia("plate_stable");
  }
}

function finalizePostCoolInertia(reason) {
  if (!STATE.postCoolActive) return;

  STATE.lastPostCoolMinC = STATE.postCoolMinC;
  if (isFiniteNumber(STATE.postCoolTargetC) && isFiniteNumber(STATE.postCoolMinC)) {
    var overshoot = STATE.postCoolTargetC - STATE.postCoolMinC;
    STATE.lastOvershootC = overshoot;
    if (overshoot > 2.0) {
      STATE.learnedCoolMaxS = Math.max(
        CONFIG.adaptiveCoolMaxMinS,
        STATE.learnedCoolMaxS - CONFIG.adaptiveCoolOvershootStepDownS
      );
      STATE.lastDecision = "learn_runtime_down:overshoot_" + overshoot.toFixed(2);
    }
  } else {
    STATE.lastOvershootC = null;
  }

  STATE.postCoolActive = false;
  STATE.postCoolStartedAt = 0;
  STATE.postCoolTargetC = null;
  STATE.postCoolMinC = null;
  STATE.postCoolLastMeaningfulMinAt = 0;
  STATE.postCoolLastC = null;
  STATE.lastPostCoolFinalizeReason = reason;
}

function beginPostCoolInertia(ts, plateTargetC, plateC) {
  STATE.postCoolActive = true;
  STATE.postCoolStartedAt = ts;
  STATE.postCoolTargetC = isFiniteNumber(plateTargetC) ? plateTargetC : null;
  STATE.postCoolMinC = isFiniteNumber(plateC) ? plateC : null;
  STATE.postCoolLastMeaningfulMinAt = ts;
  STATE.postCoolLastC = isFiniteNumber(plateC) ? plateC : null;
}

function updateCondensingStats(dtS, condensingNow, coolingNow, dryingActiveNow) {
  if (dtS <= 0) return;

  var windowS = Math.max(60, CONFIG.condensingRecentWindowS);
  var decay = 1.0 - (dtS / windowS);
  if (decay < 0) decay = 0;

  STATE.recentWindowTotalS = STATE.recentWindowTotalS * decay + dtS;
  STATE.recentWindowCondensingS = STATE.recentWindowCondensingS * decay + (condensingNow ? dtS : 0);
  STATE.recentDryingCompressorS = STATE.recentDryingCompressorS * decay + ((dryingActiveNow && coolingNow) ? dtS : 0);
  STATE.recentDryingCondensingS = STATE.recentDryingCondensingS * decay + ((dryingActiveNow && condensingNow) ? dtS : 0);

  if (condensingNow) STATE.condensingTotalS += dtS;
  if (dryingActiveNow) STATE.dryingActiveTotalS += dtS;
}

function applyOutputs(nextCool, nextHeat, allowSimultaneous, reason, plateTargetC, plateC, ts, startPostCoolTracking) {
  if (typeof startPostCoolTracking !== "boolean") startPostCoolTracking = true;
  if (nextCool && nextHeat && !allowSimultaneous) {
    nextHeat = false;
    reason = reason + "|mutex";
  }

  if (STATE.coolOn !== nextCool) {
    setSwitch(CONFIG.coolSwitchId, nextCool);
    STATE.coolOn = nextCool;

    if (nextCool) {
      STATE.compressorStarts += 1;
      STATE.coolingStartedAt = ts;
      STATE.cycleStopReason = "none";
      STATE.lastPlateEvent = "none";
      STATE.lastDecision = "cool_on:" + reason;
    } else {
      STATE.coolingLockoutUntil = ts + CONFIG.lockoutS;
      STATE.lastDecision = "cool_off:" + reason;
      if (startPostCoolTracking) {
        beginPostCoolInertia(ts, plateTargetC, plateC);
      }
    }
  }

  if (STATE.heatOn !== nextHeat) {
    setSwitch(CONFIG.heatSwitchId, nextHeat);
    STATE.heatOn = nextHeat;
    STATE.lastDecision = (nextHeat ? "heat_on:" : "heat_off:") + reason;
  }
}

function controlLoop() {
  var ts = nowS();
  var airC = readTempC(CONFIG.localAirTempSensorId);
  var plateC = readTempC(CONFIG.localPlateTempSensorId);

  updatePostCoolInertia(ts, plateC);

  if (!isFiniteNumber(airC)) {
    STATE.machineState = MACHINE.FAULT;
    STATE.coolReason = "air_sensor_missing";
    STATE.heatReason = "air_sensor_missing";
    applyOutputs(false, false, false, "air_missing", null, plateC, ts, false);
    publishFault("AIR_SENSOR_MISSING", "critical", "Local air sensor unavailable; outputs forced off");
    publishState(
      ts,
      airC,
      plateC,
      null,
      null,
      null,
      "not_available",
      "temp_only",
      null,
      false,
      false,
      false,
      false,
      "humidity_stale",
      "not_available"
    );
    return;
  }

  var dtS = 0;
  if (STATE.lastLoopTs > 0 && ts > STATE.lastLoopTs) dtS = ts - STATE.lastLoopTs;
  STATE.lastLoopTs = ts;

  var extTempOk = externalTempFresh(ts);
  var extHumOk = externalHumidityFresh(ts);

  if (!extTempOk && isFiniteNumber(STATE.externalTempC)) {
    publishFault("EXTERNAL_TEMP_STALE", "info", "External temperature stale; fallback to local air sensor");
  }
  if (!extHumOk && isFiniteNumber(STATE.externalHumidityRh)) {
    publishFault("EXTERNAL_HUMIDITY_STALE", "info", "External humidity stale; switching to temperature-only mode");
  }

  var controlTempC = extTempOk ? STATE.externalTempC : airC;
  var humidityRh = extHumOk ? STATE.externalHumidityRh : null;
  var mode = extHumOk ? "temp+humidity" : "temp_only";

  var dewTempSource = "local_air";
  var dewTempC = airC;
  if (CONFIG.dewPointTempSource === "external_if_fresh" && extTempOk) {
    dewTempC = STATE.externalTempC;
    dewTempSource = "external_fresh";
  }

  if (!isFiniteNumber(plateC)) {
    publishFault("PLATE_SENSOR_MISSING", "warning", "Plate sensor unavailable; cooling blocked");
  } else {
    if (plateC <= CONFIG.plateMinOffC) {
      STATE.plateTooColdLatch = true;
    } else if (plateC >= CONFIG.plateMinResumeC) {
      STATE.plateTooColdLatch = false;
    }
  }

  var dewC = extHumOk ? dewPointC(dewTempC, humidityRh) : null;
  var plateTargetC = null;
  if (isFiniteNumber(dewC)) {
    plateTargetC = dewC - CONFIG.dewTargetMarginC;
  }

  var coolingAvailable = isFiniteNumber(plateC) && !STATE.plateTooColdLatch;
  var lockoutActive = ts < STATE.coolingLockoutUntil && !STATE.coolOn;

  var heatDemand = false;
  if (STATE.heatOn) {
    heatDemand = controlTempC < CONFIG.heatOffC && controlTempC < CONFIG.heatDisableAboveC;
  } else {
    heatDemand = controlTempC <= CONFIG.heatOnC && controlTempC < CONFIG.heatDisableAboveC;
  }

  var thermalCoolDemand;
  if (STATE.coolOn) {
    thermalCoolDemand = controlTempC > CONFIG.coolOffC;
  } else {
    thermalCoolDemand = controlTempC >= CONFIG.coolOnC;
  }

  var hardMaxActive = airC >= CONFIG.hardMaxAirC;
  if (hardMaxActive) {
    thermalCoolDemand = true;
    heatDemand = false;
    STATE.dryingOvertempSuspend = true;
  } else if (STATE.dryingOvertempSuspend && airC <= CONFIG.dryingResumeBelowHardMaxC) {
    STATE.dryingOvertempSuspend = false;
  }

  var rhSetpoint = clamp(STATE.humiditySetpointRh, CONFIG.humiditySetpointMinRh, CONFIG.humiditySetpointMaxRh);
  STATE.humiditySetpointEffectiveRh = rhSetpoint;

  var dryingDemand = false;
  if (!STATE.dryingOvertempSuspend && extHumOk) {
    var halfRhBand = CONFIG.humiditySetpointHysteresisRh / 2.0;
    var rhOnDyn = rhSetpoint + halfRhBand;
    var rhOffDyn = rhSetpoint - halfRhBand;
    if (rhOffDyn >= rhOnDyn) rhOffDyn = rhOnDyn - 0.1;

    if (STATE.machineState === MACHINE.DRYING_ACTIVE) {
      dryingDemand = humidityRh > rhOffDyn;
    } else {
      dryingDemand = humidityRh >= rhOnDyn;
    }
  }

  // Télémétrie humidité explicite (sans impact décisionnel).
  var humidityControlAvailable = extHumOk;
  var humidityDemandActive = dryingDemand;
  var dryingModeRequested = dryingDemand && extHumOk && isFiniteNumber(plateTargetC);
  var humidityMode = "not_available";
  if (extHumOk) {
    humidityMode = "external_valid";
  } else if (isFiniteNumber(STATE.externalHumidityRh)) {
    humidityMode = "external_stale";
  }

  var dryingBlockReason = "none";
  if (!extHumOk) {
    dryingBlockReason = "humidity_stale";
  } else if (STATE.dryingOvertempSuspend) {
    dryingBlockReason = "overtemp_suspend";
  } else if (!dryingDemand) {
    dryingBlockReason = "no_humidity_request";
  } else if (!isFiniteNumber(plateTargetC)) {
    dryingBlockReason = "no_plate_target";
  }

  var nextState = MACHINE.IDLE;
  var wantCool = false;
  var wantHeat = false;
  var allowSimultaneous = false;
  var coolReason = "none";
  var heatReason = "none";

  if (!STATE.enabled) {
    nextState = MACHINE.IDLE;
    coolReason = "disabled";
    heatReason = "disabled";
  } else if (STATE.postCoolActive) {
    // Priorité forte: figer les sorties pendant l'observation d'inertie.
    nextState = MACHINE.POST_COOL_INERTIA;
    wantCool = false;
    wantHeat = false;
    allowSimultaneous = false;
    coolReason = "inertia_lockout";
    heatReason = "inertia_lockout";
  } else if (hardMaxActive || STATE.dryingOvertempSuspend) {
    // Priorité sécurité ambiance: surchauffe air => on suspend le séchage actif.
    nextState = MACHINE.COOLING;
    wantHeat = false;
    heatReason = "hardmax_override";

    if (!coolingAvailable) {
      wantCool = false;
      coolReason = "plate_safety_block";
    } else if (lockoutActive) {
      wantCool = false;
      coolReason = "lockout";
    } else {
      wantCool = true;
      coolReason = hardMaxActive ? "hardmax_protection" : "hardmax_recovery";
    }
  } else if (dryingDemand && extHumOk && isFiniteNumber(plateTargetC)) {
    nextState = MACHINE.DRYING_ACTIVE;
    allowSimultaneous = true;

    wantHeat = computeDryingHeatDemand(airC);
    heatReason = wantHeat ? "drying_air_setpoint" : "drying_air_hysteresis";

    // Priorité arrêt DRYING_ACTIVE: sécurité plaque -> cible/hystérésis plaque -> garde-fou runtime.
    if (coolingAvailable && !lockoutActive) {
      var halfPlateHyst = CONFIG.plateTargetHysteresisC / 2.0;
      var plateOn = plateTargetC + halfPlateHyst;
      var plateOff = plateTargetC - halfPlateHyst;

      if (STATE.coolOn) {
        wantCool = plateC > plateOff;
      } else {
        wantCool = plateC >= plateOn;
      }

      if (wantCool) {
        coolReason = "drying_plate_target";
      } else {
        coolReason = "drying_plate_hysteresis";
      }
    } else {
      wantCool = false;
      coolReason = !coolingAvailable ? "plate_safety_block" : "lockout";
    }
  } else if (heatDemand) {
    nextState = MACHINE.HEATING;
    wantHeat = true;
    heatReason = "low_temp_protection";
    coolReason = "heating_priority";
  } else if (thermalCoolDemand) {
    nextState = MACHINE.COOLING;
    if (!coolingAvailable) {
      wantCool = false;
      coolReason = "plate_safety_block";
    } else if (lockoutActive) {
      wantCool = false;
      coolReason = "lockout";
    } else {
      wantCool = true;
      coolReason = "thermal_demand";
    }
    heatReason = "none";
  } else {
    nextState = MACHINE.IDLE;
    coolReason = "no_demand";
    heatReason = "no_demand";
  }

  if (STATE.coolOn && wantCool) {
    var runS = ts - STATE.coolingStartedAt;
    if (runS >= STATE.learnedCoolMaxS) {
      wantCool = false;
      coolReason = "learned_runtime_limit";
    }

    if (isFiniteNumber(plateTargetC) && plateC <= plateTargetC && !STATE.learnedCoolReady) {
      STATE.learnedCoolMaxS = clamp(runS, CONFIG.adaptiveCoolMaxMinS, CONFIG.adaptiveCoolMaxMaxS);
      STATE.learnedCoolReady = true;
      STATE.lastDecision = "learn_runtime_init:" + STATE.learnedCoolMaxS;
    }

    if (isFiniteNumber(plateTargetC) && plateC <= plateTargetC) {
      STATE.lastPlateEvent = "plate_target_reached";
    }
  }

  if (STATE.coolOn && !wantCool) {
    STATE.cycleStopReason = coolReason;
  }

  var condensingNow = isFiniteNumber(plateC) && isFiniteNumber(dewC) && plateC < dewC;
  updateCondensingStats(dtS, condensingNow, STATE.coolOn, STATE.machineState === MACHINE.DRYING_ACTIVE);

  var dryingCondensingPct = null;
  if (STATE.recentDryingCompressorS > 0.1) {
    dryingCondensingPct = 100.0 * (STATE.recentDryingCondensingS / STATE.recentDryingCompressorS);
  }

  STATE.dryingIneffective = (nextState === MACHINE.DRYING_ACTIVE) &&
    (STATE.recentDryingCompressorS >= CONFIG.dryingIneffectiveMinCompressorS) &&
    isFiniteNumber(dryingCondensingPct) &&
    (dryingCondensingPct < CONFIG.dryingIneffectiveMinCondensingPct);
  STATE.dryingIneffectiveReason = STATE.dryingIneffective ? "insufficient_condensing_under_compressor" : "none";

  if (STATE.dryingIneffective && coolReason === "drying_plate_target") {
    coolReason = "drying_ineffective";
  }

  STATE.machineState = nextState;
  STATE.coolReason = coolReason;
  STATE.heatReason = heatReason;

  applyOutputs(wantCool, wantHeat, allowSimultaneous, nextState + ":" + coolReason + ":" + heatReason, plateTargetC, plateC, ts, true);
  publishState(
    ts,
    airC,
    plateC,
    controlTempC,
    humidityRh,
    dewC,
    dewTempSource,
    mode,
    plateTargetC,
    allowSimultaneous,
    humidityControlAvailable,
    humidityDemandActive,
    dryingModeRequested,
    dryingBlockReason,
    humidityMode
  );
}

function publishState(
  ts,
  airC,
  plateC,
  controlTempC,
  humidityRh,
  dewC,
  dewTempSource,
  mode,
  plateTargetC,
  allowSimultaneous,
  humidityControlAvailable,
  humidityDemandActive,
  dryingModeRequested,
  dryingBlockReason,
  humidityMode
) {
  if ((ts - STATE.lastPublishedAt) * 1000 < CONFIG.mqttPublishMs) return;
  STATE.lastPublishedAt = ts;

  mqttPublish("state", {
    enabled: STATE.enabled,
    target_humidity_rh: STATE.humiditySetpointEffectiveRh,
    target_humidity_requested_rh: STATE.humiditySetpointRh,
    mode: mode,
    machine_state: STATE.machineState,
    cool_reason: STATE.coolReason,
    heat_reason: STATE.heatReason,
    simultaneous_mode_active: allowSimultaneous,
    air_c: airC,
    plate_c: plateC,
    control_temp_c: controlTempC,
    humidity_rh: humidityRh,
    humidity_control_available: humidityControlAvailable,
    humidity_demand_active: humidityDemandActive,
    drying_mode_requested: dryingModeRequested,
    drying_block_reason: dryingBlockReason,
    humidity_mode: humidityMode,
    dew_temp_source: dewTempSource,
    dew_point_c: dewC,
    plate_target_c: plateTargetC,
    plate_minus_dew_c: (isFiniteNumber(plateC) && isFiniteNumber(dewC)) ? (plateC - dewC) : null,
    condensing_now: (isFiniteNumber(plateC) && isFiniteNumber(dewC)) ? (plateC < dewC) : false,
    condensing_margin_c: (isFiniteNumber(plateC) && isFiniteNumber(dewC) && plateC < dewC) ? (dewC - plateC) : null,
    condensing_total_s: STATE.condensingTotalS,
    drying_active_total_s: STATE.dryingActiveTotalS,
    condensing_recent_percent: STATE.recentWindowTotalS > 0.1 ? (100.0 * STATE.recentWindowCondensingS / STATE.recentWindowTotalS) : null,
    compressor_starts: STATE.compressorStarts,
    drying_ineffective: STATE.dryingIneffective,
    drying_ineffective_reason: STATE.dryingIneffectiveReason,
    drying_condensing_percent: STATE.recentDryingCompressorS > 0.1 ? (100.0 * STATE.recentDryingCondensingS / STATE.recentDryingCompressorS) : null,
    drying_recent_compressor_s: STATE.recentDryingCompressorS,
    external_temp_fresh: externalTempFresh(ts),
    external_humidity_fresh: externalHumidityFresh(ts),
    cool_on: STATE.coolOn,
    heat_on: STATE.heatOn,
    lockout_remaining_s: Math.max(0, STATE.coolingLockoutUntil - ts),
    plate_too_cold_latch: STATE.plateTooColdLatch,
    drying_overtemp_suspend: STATE.dryingOvertempSuspend,
    cycle_stop_reason: STATE.cycleStopReason,
    last_plate_event: STATE.lastPlateEvent,
    last_post_cool_finalize_reason: STATE.lastPostCoolFinalizeReason,
    last_min_plate_after_stop_c: STATE.lastPostCoolMinC,
    overshoot_c: STATE.lastOvershootC,
    learned_max_runtime_s: STATE.learnedCoolMaxS,
    post_cool_active: STATE.postCoolActive,
    decision: STATE.lastDecision,
    fault: STATE.lastFaultCode,
    ts: ts
  });
}

function mqttInit() {
  if (typeof MQTT === "undefined") return;
  var baseTopic = CONFIG.mqttPrefix + "/" + CONFIG.haObjectId;

  MQTT.subscribe(CONFIG.externalTempTopic, function (topic, payload) {
    var n = parseNumericPayload(payload);
    if (!isFiniteNumber(n)) return;
    STATE.externalTempC = n;
    STATE.externalTempTs = nowS();
  });

  MQTT.subscribe(CONFIG.externalHumidityTopic, function (topic, payload) {
    var n = parseNumericPayload(payload);
    if (!isFiniteNumber(n) || n < 0 || n > 100) return;
    STATE.externalHumidityRh = n;
    STATE.externalHumidityTs = nowS();
  });

  MQTT.subscribe(baseTopic + "/set/mode", function (topic, payload) {
    if (payload === "off") {
      STATE.enabled = false;
    } else if (payload === "auto") {
      STATE.enabled = true;
    }
  });

  MQTT.subscribe(baseTopic + "/set/target_humidity", function (topic, payload) {
    var n = parseNumericPayload(payload);
    if (!isFiniteNumber(n) || n < 0 || n > 100) return;
    STATE.humiditySetpointRh = n;
  });
}

function bootstrap() {
  applyOutputs(false, false, false, "boot_safe", null, null, nowS(), false);
  mqttInit();
  purgeDiscoveryConfigs();
  publishAllDiscoveryConfigs();
  Timer.set(CONFIG.loopMs, true, controlLoop);
  publishFault("BOOT", "info", "Controller started");
}

bootstrap();
