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

  loopMs: 5000,
  mqttPublishMs: 5000,
  // Discovery HA allégé par défaut pour limiter RAM/CPU au boot Shelly.
  discoveryExtendedEnabled: false,
  // Option legacy conservée pour compatibilité config; la publication condensation en minimal est forcée OFF.
  discoveryCondensationDiagnosticsEnabled: false,
  // Migration discovery HA: debug optionnel des payloads envoyés (coûteux en mémoire).
  discoveryDebugEnabled: false,
  discoveryDebugTopicSuffix: "debug/discovery_payload",

};

var MACHINE = {
  IDLE: "IDLE",
  COOLING: "COOLING",
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
  plateTooColdLatch: false,
  dryingOvertempSuspend: false,

  lastFaultCode: "none",
  lastPublishedAt: 0,
  lastDecision: "startup",

  dehumActive: false,
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
  { component: "sensor", key: "dew_point" },
  { component: "sensor", key: "plate_target" },
  { component: "sensor", key: "plate_minus_dew" },
  { component: "binary_sensor", key: "condensing_now" },
  // Ancienne entité historique à purger.
  { component: "climate", key: "climate" }
];

var DISCOVERY_CONDENSATION_DIAG_ENTITIES = [
  { component: "sensor", key: "dew_point" },
  { component: "sensor", key: "plate_target" },
  { component: "sensor", key: "plate_minus_dew" },
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

  if (!CONFIG.discoveryExtendedEnabled) return;

  // Mode étendu optionnel: réduit au noyau condensation utile (mémoire).

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

  publishDiscoveryConfig("binary_sensor", "condensing_now", {
    name: "Cave Condensing Now",
    state_topic: stateTopic,
    value_template: "{{ value_json.condensing_now | string | lower }}",
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
      STATE.cycleStopReason = "none";
      STATE.lastPlateEvent = "none";
      STATE.lastDecision = "cool_on:" + reason;
    } else {
      STATE.coolingLockoutUntil = ts + CONFIG.lockoutS;
      STATE.lastDecision = "cool_off:" + reason;
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

  STATE.lastLoopTs = ts;

  var extTempOk = externalTempFresh(ts);
  var extHumOk = externalHumidityFresh(ts);

  if (!extTempOk && isFiniteNumber(STATE.externalTempC)) {
    publishFault("EXTERNAL_TEMP_STALE", "info", "External temperature stale; fallback to local air sensor");
  }
  if (!extHumOk && isFiniteNumber(STATE.externalHumidityRh)) {
    publishFault("EXTERNAL_HUMIDITY_STALE", "info", "External humidity stale; switching to temperature-only mode");
  }

  var internalTempC = airC;
  var controlTempC = extTempOk ? STATE.externalTempC : internalTempC;
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

    // Compensation forcée en déshumidification: si air < consigne, chauffage ON.
    wantHeat = airC < CONFIG.dryingAirSetpointC;
    heatReason = wantHeat ? "dehum_comp_forced_below_setpoint" : "dehum_comp_not_needed";

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

  if (STATE.coolOn && !wantCool) {
    STATE.cycleStopReason = coolReason;
  }

  var dehumActive = (nextState === MACHINE.DRYING_ACTIVE);
  STATE.dehumActive = dehumActive;

  STATE.machineState = nextState;
  STATE.coolReason = coolReason;
  STATE.heatReason = heatReason;

  applyOutputs(wantCool, wantHeat, allowSimultaneous, nextState + ":" + coolReason + ":" + heatReason, plateTargetC, plateC, ts, false);
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
  var hasPlateAndDew = isFiniteNumber(plateC) && isFiniteNumber(dewC);
  var plateMinusDewC = hasPlateAndDew ? (plateC - dewC) : null;
  var condensingNow = hasPlateAndDew ? (plateC < dewC) : false;

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
    dehum_active: STATE.dehumActive,
    drying_block_reason: dryingBlockReason,
    humidity_mode: humidityMode,
    dew_temp_source: dewTempSource,
    dew_point_c: dewC,
    plate_target_c: plateTargetC,
    plate_minus_dew_c: plateMinusDewC,
    condensing_now: condensingNow,
    external_temp_fresh: externalTempFresh(ts),
    external_humidity_fresh: externalHumidityFresh(ts),
    cool_on: STATE.coolOn,
    heat_on: STATE.heatOn,
    lockout_remaining_s: Math.max(0, STATE.coolingLockoutUntil - ts),
    plate_too_cold_latch: STATE.plateTooColdLatch,
    drying_overtemp_suspend: STATE.dryingOvertempSuspend,
    cycle_stop_reason: STATE.cycleStopReason,
    last_plate_event: STATE.lastPlateEvent,
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
