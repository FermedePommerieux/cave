/*
 * cave_saucisson.js
 *
 * Contrôleur embarqué Shelly Script pour cave à saucissons.
 *
 * Objectif de cette version:
 * - Garder strictement la logique métier existante (pas de changement fonctionnel).
 * - Rendre le code lisible pour l'exploitation terrain.
 * - Documenter les décisions de régulation et leur lien avec les invariants sécurité.
 */

var CONFIG = {
  // --- MQTT / Home Assistant ---
  mqttPrefix: "fdp_communs_cave_saucissons",
  haObjectId: "cave_saucisson",

  // --- Mapping matériel Shelly ---
  localAirTempSensorId: 100,
  localPlateTempSensorId: 101,
  coolSwitchId: 0,
  heatSwitchId: 1,

  // --- Topics MQTT capteurs externes ---
  externalTempTopic: "fdp_communs_cave_saucissons/thermostat/external_temperature",
  externalHumidityTopic: "fdp_communs_cave_saucissons/thermostat/external_humidity",

  // --- Fraîcheur données externes ---
  tempStaleS: 900,
  humidityStaleS: 10800,

  // --- Valeurs par défaut opérateur ---
  defaultEnabled: true,
  defaultHumiditySetpointRh: 78.0,

  // --- Consigne humidité (bornée + hystérésis) ---
  humiditySetpointHysteresisRh: 3.0,
  humiditySetpointMinRh: 60.0,
  humiditySetpointMaxRh: 90.0,

  // --- Régulation thermique air ---
  coolOnC: 13.0,
  coolOffC: 11.5,
  heatOnC: 10.5,
  heatOffC: 11.5,
  heatDisableAboveC: 13.5,

  // --- Sécurité ambiance en séchage ---
  hardMaxAirC: 14.0,
  dryingResumeBelowHardMaxC: 13.5,

  // --- Compensation chauffage pendant séchage ---
  dryingAirSetpointC: 12.0,
  dryingAirHysteresisC: 0.6,

  // --- Sécurité compresseur / plaque ---
  lockoutS: 180,
  plateMinOffC: 0.0,
  plateMinResumeC: 3.0,

  // --- Pilotage plaque autour du point de rosée ---
  dewTargetMarginC: 1.0,
  plateTargetHysteresisC: 0.6,
  dewPointTempSource: "local_air", // ou "external_if_fresh"

  // --- Boucle / publication ---
  loopMs: 5000,
  mqttPublishMs: 5000,
  mqttPublishOnTransition: true,

  // --- Discovery HA ---
  discoveryExtendedEnabled: false,
  discoveryDebugEnabled: false,
  discoveryDebugTopicSuffix: "debug/discovery_payload"
};

var MACHINE = {
  IDLE: "IDLE",
  COOLING: "COOLING",
  HEATING: "HEATING",
  DRYING_ACTIVE: "DRYING_ACTIVE",
  FAULT: "FAULT"
};

var STATE = {
  // Configuration runtime
  enabled: CONFIG.defaultEnabled,
  humiditySetpointRh: CONFIG.defaultHumiditySetpointRh,
  humiditySetpointEffectiveRh: CONFIG.defaultHumiditySetpointRh,

  // Dernières mesures MQTT externes + timestamp réception
  externalTempC: null,
  externalTempTs: 0,
  externalHumidityRh: null,
  externalHumidityTs: 0,

  // États actionneurs
  coolOn: false,
  heatOn: false,
  coolingLockoutUntil: 0,

  // Latches sécurité
  plateTooColdLatch: false,
  airTooColdForCoolingLatch: false,
  dryingOvertempSuspend: false,

  // Télémétrie de décision
  machineState: MACHINE.IDLE,
  coolReason: "none",
  heatReason: "none",
  cycleStopReason: "none",
  lastPlateEvent: "none",
  lastDecision: "startup",
  lastFaultCode: "none",

  // État fonctionnel
  dehumActive: false,
  lastPublishedAt: 0,
  forcePublishState: false,

  // Anti-spam défauts informatifs (transitions seulement)
  externalTempWasFresh: null,
  externalHumidityWasFresh: null
};

// ---------- Helpers génériques ----------

function nowS() {
  var sys = Shelly.getComponentStatus("sys");
  if (sys && typeof sys.unixtime === "number" && sys.unixtime > 0) return sys.unixtime;
  return Math.floor(Date.now() / 1000);
}

function okNum(v) {
  return typeof v === "number" && isFinite(v);
}

function clamp(v, minV, maxV) {
  if (v < minV) return minV;
  if (v > maxV) return maxV;
  return v;
}

function readTempC(sensorId) {
  var st = Shelly.getComponentStatus("temperature:" + sensorId);
  if (!st) return null;
  if (okNum(st.tC)) return st.tC;
  if (okNum(st.value)) return st.value;
  return null;
}

function parseNum(payload) {
  if (typeof payload === "number") return payload;
  if (typeof payload !== "string") return null;
  var n = Number(payload);
  return okNum(n) ? n : null;
}

function fresh(value, nowTs, valueTs, maxAgeS) {
  return okNum(value) && (nowTs - valueTs) <= maxAgeS;
}

function dewPointC(tempC, humidityRh) {
  if (!okNum(tempC) || !okNum(humidityRh) || humidityRh <= 0 || humidityRh > 100) return null;
  // Formule Magnus (suffisante pour cet usage terrain).
  var a = 17.62;
  var b = 243.12;
  var gamma = Math.log(humidityRh / 100) + (a * tempC) / (b + tempC);
  return (b * gamma) / (a - gamma);
}

function setSwitch(switchId, on) {
  Shelly.call("Switch.Set", { id: switchId, on: on });
}

function configErrors() {
  var errs = [];

  if (CONFIG.coolSwitchId === CONFIG.heatSwitchId) errs.push("coolSwitchId must differ from heatSwitchId");
  if (CONFIG.localAirTempSensorId === CONFIG.localPlateTempSensorId) {
    errs.push("localAirTempSensorId must differ from localPlateTempSensorId");
  }

  if (!(CONFIG.coolOffC < CONFIG.coolOnC)) errs.push("coolOffC must be lower than coolOnC");
  if (!(CONFIG.heatOnC < CONFIG.heatOffC)) errs.push("heatOnC must be lower than heatOffC");
  if (!(CONFIG.plateMinOffC < CONFIG.plateMinResumeC)) {
    errs.push("plateMinOffC must be lower than plateMinResumeC");
  }
  if (!(CONFIG.dryingResumeBelowHardMaxC < CONFIG.hardMaxAirC)) {
    errs.push("dryingResumeBelowHardMaxC must be lower than hardMaxAirC");
  }
  if (!(CONFIG.lockoutS >= 0)) errs.push("lockoutS must be >= 0");
  if (!(CONFIG.loopMs > 0 && CONFIG.mqttPublishMs > 0)) errs.push("loopMs/mqttPublishMs must be > 0");
  if (!(CONFIG.humiditySetpointMinRh < CONFIG.humiditySetpointMaxRh)) {
    errs.push("humiditySetpointMinRh must be lower than humiditySetpointMaxRh");
  }
  if (!(CONFIG.humiditySetpointHysteresisRh > 0)) errs.push("humiditySetpointHysteresisRh must be > 0");
  if (!(CONFIG.plateTargetHysteresisC > 0)) errs.push("plateTargetHysteresisC must be > 0");
  if (!(CONFIG.dryingAirHysteresisC > 0)) errs.push("dryingAirHysteresisC must be > 0");
  if (!(CONFIG.dewTargetMarginC > 0)) errs.push("dewTargetMarginC must be > 0");

  return errs;
}

// -----------------------------------------------------------------------------
// Cœur métier: computeDecision
// -----------------------------------------------------------------------------
// Cette fonction applique les règles de priorité suivantes:
// 1) sécurité capteur air (FAULT) >
// 2) sécurité plaque / air trop froid pour compresseur >
// 3) protection hard-max air >
// 4) séchage (si humidité valide) >
// 5) régulation thermique simple.
//
// Invariants non négociables appliqués ici:
// - Jamais de chauffage piloté directement par RH.
// - Simultané chaud+froid interdit hors DRYING_ACTIVE.
// - Si air local indisponible => FAULT + sorties OFF.
// - RH externe invalide/périmée => mode température seule.
// -----------------------------------------------------------------------------
function computeDecision(ts) {
  var airC = readTempC(CONFIG.localAirTempSensorId);
  var plateC = readTempC(CONFIG.localPlateTempSensorId);

  var extTempOk = fresh(STATE.externalTempC, ts, STATE.externalTempTs, CONFIG.tempStaleS);
  var extHumOk = fresh(STATE.externalHumidityRh, ts, STATE.externalHumidityTs, CONFIG.humidityStaleS);

  // Fallback température: externe fraîche sinon sonde air locale.
  var controlTempC = extTempOk ? STATE.externalTempC : airC;

  // RH utilisée seulement si valide/fraîche; sinon mode temp_only.
  var humidityRh = extHumOk ? STATE.externalHumidityRh : null;

  // Source T pour point de rosée configurable mais robuste.
  var dewTempUsesExternal = CONFIG.dewPointTempSource === "external_if_fresh" && extTempOk;
  var dewTempC = dewTempUsesExternal ? STATE.externalTempC : airC;
  var dewTempSource = dewTempUsesExternal ? "external_fresh" : "local_air";

  var dewC = extHumOk ? dewPointC(dewTempC, humidityRh) : null;
  var plateTargetC = okNum(dewC) ? dewC - CONFIG.dewTargetMarginC : null;

  // Invariant sécurité #2: si sonde air locale manquante, arrêt immédiat.
  if (!okNum(airC)) {
    return {
      airC: airC,
      plateC: plateC,
      controlTempC: controlTempC,
      humidityRh: humidityRh,
      dewC: dewC,
      plateTargetC: plateTargetC,
      dewTempSource: dewTempSource,
      mode: extHumOk ? "temp+humidity" : "temp_only",
      state: MACHINE.FAULT,
      wantCool: false,
      wantHeat: false,
      allowSim: false,
      coolReason: "air_sensor_missing",
      heatReason: "air_sensor_missing",
      humidityControlAvailable: extHumOk,
      humidityDemandActive: false,
      dryingModeRequested: false,
      dryingBlockReason: "humidity_stale",
      humidityMode: "not_available"
    };
  }

  // Latch anti-gel plaque.
  if (okNum(plateC)) {
    if (plateC <= CONFIG.plateMinOffC) STATE.plateTooColdLatch = true;
    else if (plateC >= CONFIG.plateMinResumeC) STATE.plateTooColdLatch = false;
  } else {
    publishFault("PLATE_SENSOR_MISSING", "warning", "Plate sensor unavailable; cooling blocked");
  }

  // Latch air trop froid: bloque compresseur même en DRYING_ACTIVE.
  if (airC <= CONFIG.heatOnC) STATE.airTooColdForCoolingLatch = true;
  else if (airC >= CONFIG.heatOffC) STATE.airTooColdForCoolingLatch = false;

  var coolingBlocked = !okNum(plateC) || STATE.plateTooColdLatch || STATE.airTooColdForCoolingLatch;
  var coolingBlockReason = STATE.airTooColdForCoolingLatch ? "air_too_cold_block" : "plate_safety_block";

  // Lockout compresseur uniquement quand il est actuellement OFF.
  var lockout = ts < STATE.coolingLockoutUntil && !STATE.coolOn;

  // Hystérésis thermique air (demande chauffage/froid).
  var heatDemand = STATE.heatOn
    ? controlTempC < CONFIG.heatOffC && controlTempC < CONFIG.heatDisableAboveC
    : controlTempC <= CONFIG.heatOnC && controlTempC < CONFIG.heatDisableAboveC;

  var coolDemand = STATE.coolOn
    ? controlTempC > CONFIG.coolOffC
    : controlTempC >= CONFIG.coolOnC;

  // Priorité sécurité ambiance sur séchage.
  var hardMax = airC >= CONFIG.hardMaxAirC;
  if (hardMax) {
    coolDemand = true;
    heatDemand = false;
    STATE.dryingOvertempSuspend = true;
  } else if (STATE.dryingOvertempSuspend && airC <= CONFIG.dryingResumeBelowHardMaxC) {
    STATE.dryingOvertempSuspend = false;
  }

  // Consigne RH opérateur bornée par sécurité d'exploitation.
  var rhSp = clamp(
    STATE.humiditySetpointRh,
    CONFIG.humiditySetpointMinRh,
    CONFIG.humiditySetpointMaxRh
  );
  STATE.humiditySetpointEffectiveRh = rhSp;

  var halfRh = CONFIG.humiditySetpointHysteresisRh / 2.0;
  var rhOn = rhSp + halfRh;
  var rhOff = rhSp - halfRh;
  if (rhOff >= rhOn) rhOff = rhOn - 0.1;

  var dryingDemand = false;
  if (!STATE.dryingOvertempSuspend && extHumOk) {
    dryingDemand = STATE.machineState === MACHINE.DRYING_ACTIVE ? humidityRh > rhOff : humidityRh >= rhOn;
  }

  var humidityMode = extHumOk
    ? "external_valid"
    : okNum(STATE.externalHumidityRh)
      ? "external_stale"
      : "not_available";

  var dryingBlockReason;
  if (!extHumOk) dryingBlockReason = "humidity_stale";
  else if (STATE.dryingOvertempSuspend) dryingBlockReason = "overtemp_suspend";
  else if (!dryingDemand) dryingBlockReason = "no_humidity_request";
  else if (!okNum(plateTargetC)) dryingBlockReason = "no_plate_target";
  else dryingBlockReason = "none";

  var d = {
    airC: airC,
    plateC: plateC,
    controlTempC: controlTempC,
    humidityRh: humidityRh,
    dewC: dewC,
    plateTargetC: plateTargetC,
    dewTempSource: dewTempSource,
    mode: extHumOk ? "temp+humidity" : "temp_only",

    state: MACHINE.IDLE,
    wantCool: false,
    wantHeat: false,
    allowSim: false,
    coolReason: "no_demand",
    heatReason: "no_demand",

    humidityControlAvailable: extHumOk,
    humidityDemandActive: dryingDemand,
    dryingModeRequested: dryingDemand && extHumOk && okNum(plateTargetC),
    dryingBlockReason: dryingBlockReason,
    humidityMode: humidityMode
  };

  if (!STATE.enabled) {
    d.coolReason = "disabled";
    d.heatReason = "disabled";
    return d;
  }

  // hardMax: force priorité protection ambiance.
  if (hardMax || STATE.dryingOvertempSuspend) {
    d.state = MACHINE.COOLING;
    d.heatReason = "hardmax_override";

    if (coolingBlocked) d.coolReason = coolingBlockReason;
    else if (lockout) d.coolReason = "lockout";
    else {
      d.wantCool = true;
      d.coolReason = hardMax ? "hardmax_protection" : "hardmax_recovery";
    }
    return d;
  }

  // DRYING_ACTIVE:
  // - compresseur piloté par cible plaque autour rosée (et sécurités globales)
  // - chauffage = compensation thermique explicite (jamais direct RH)
  if (dryingDemand && extHumOk && okNum(plateTargetC)) {
    d.state = MACHINE.DRYING_ACTIVE;
    d.allowSim = true; // Seul état où simultané chaud/froid est permis.

    var heatBandHalf = CONFIG.dryingAirHysteresisC / 2.0;
    var heatOnAt = CONFIG.dryingAirSetpointC - heatBandHalf;
    var heatOffAt = CONFIG.dryingAirSetpointC + heatBandHalf;

    d.wantHeat = STATE.heatOn ? airC < heatOffAt : airC <= heatOnAt;
    d.heatReason = d.wantHeat
      ? "dehum_comp_forced_below_setpoint"
      : "dehum_comp_not_needed";

    if (coolingBlocked) d.coolReason = coolingBlockReason;
    else if (lockout) d.coolReason = "lockout";
    else {
      var plateBandHalf = CONFIG.plateTargetHysteresisC / 2.0;
      var plateOnAt = plateTargetC + plateBandHalf;
      var plateOffAt = plateTargetC - plateBandHalf;
      d.wantCool = STATE.coolOn ? plateC > plateOffAt : plateC >= plateOnAt;
      d.coolReason = d.wantCool ? "drying_plate_target" : "drying_plate_hysteresis";
    }

    return d;
  }

  // Mode thermique simple.
  if (heatDemand) {
    d.state = MACHINE.HEATING;
    d.wantHeat = true;
    d.coolReason = "heating_priority";
    d.heatReason = "low_temp_protection";
    return d;
  }

  if (coolDemand) {
    d.state = MACHINE.COOLING;
    d.heatReason = "none";

    if (coolingBlocked) d.coolReason = coolingBlockReason;
    else if (lockout) d.coolReason = "lockout";
    else {
      d.wantCool = true;
      d.coolReason = "thermal_demand";
    }

    return d;
  }

  return d;
}

// Applique la décision et maintient une télémétrie cohérente.
function applyDecision(ts, d) {
  var changed = false;
  var prevMachine = STATE.machineState;
  var wasCoolOn = STATE.coolOn;

  // Invariant sécurité #1: mutex chaud/froid hors DRYING_ACTIVE.
  if (d.wantCool && d.wantHeat && !d.allowSim) {
    d.wantHeat = false;
    d.coolReason = d.coolReason + "|mutex";
  }

  if (STATE.coolOn !== d.wantCool) {
    setSwitch(CONFIG.coolSwitchId, d.wantCool);
    STATE.coolOn = d.wantCool;
    changed = true;

    STATE.lastDecision =
      (d.wantCool ? "cool_on:" : "cool_off:") + d.state + ":" + d.coolReason + ":" + d.heatReason;

    // Lockout armé à chaque arrêt compresseur.
    if (!d.wantCool) {
      STATE.coolingLockoutUntil = ts + CONFIG.lockoutS;
    } else {
      STATE.cycleStopReason = "none";
      STATE.lastPlateEvent = "none";
    }
  }

  if (STATE.heatOn !== d.wantHeat) {
    setSwitch(CONFIG.heatSwitchId, d.wantHeat);
    STATE.heatOn = d.wantHeat;
    changed = true;
    STATE.lastDecision =
      (d.wantHeat ? "heat_on:" : "heat_off:") + d.state + ":" + d.coolReason + ":" + d.heatReason;
  }

  // Capture explicite du front descendant compresseur avant mutation d'état.
  if (wasCoolOn && !d.wantCool) STATE.cycleStopReason = d.coolReason;

  STATE.machineState = d.state;
  STATE.coolReason = d.coolReason;
  STATE.heatReason = d.heatReason;
  STATE.dehumActive = d.state === MACHINE.DRYING_ACTIVE;

  if (prevMachine !== STATE.machineState) changed = true;

  if (d.state === MACHINE.DRYING_ACTIVE && okNum(d.plateC) && okNum(d.plateTargetC)) {
    if (!STATE.coolOn) {
      STATE.lastPlateEvent = "plate_target_reached";
    } else if (d.coolReason === "drying_plate_target") {
      STATE.lastPlateEvent = "plate_above_target";
    }
  } else if (d.coolReason === "plate_safety_block") {
    STATE.lastPlateEvent = "plate_safety_blocked";
  }

  if (CONFIG.mqttPublishOnTransition && changed) STATE.forcePublishState = true;
}

function loop() {
  var ts = nowS();
  var d = computeDecision(ts);
  var extTempFreshNow = fresh(STATE.externalTempC, ts, STATE.externalTempTs, CONFIG.tempStaleS);
  var extHumFreshNow = fresh(STATE.externalHumidityRh, ts, STATE.externalHumidityTs, CONFIG.humidityStaleS);

  if (STATE.externalHumidityWasFresh === null) STATE.externalHumidityWasFresh = extHumFreshNow;
  if (STATE.externalTempWasFresh === null) STATE.externalTempWasFresh = extTempFreshNow;

  if (okNum(STATE.externalHumidityRh) && STATE.externalHumidityWasFresh && !extHumFreshNow) {
    publishFault(
      "EXTERNAL_HUMIDITY_STALE",
      "info",
      "External humidity stale; switching to temperature-only mode"
    );
  } else if (okNum(STATE.externalHumidityRh) && !STATE.externalHumidityWasFresh && extHumFreshNow) {
    publishFault("EXTERNAL_HUMIDITY_FRESH", "info", "External humidity fresh again");
  }

  if (okNum(STATE.externalTempC) && STATE.externalTempWasFresh && !extTempFreshNow) {
    publishFault(
      "EXTERNAL_TEMP_STALE",
      "info",
      "External temperature stale; fallback to local air sensor"
    );
  } else if (okNum(STATE.externalTempC) && !STATE.externalTempWasFresh && extTempFreshNow) {
    publishFault("EXTERNAL_TEMP_FRESH", "info", "External temperature fresh again");
  }

  STATE.externalHumidityWasFresh = extHumFreshNow;
  STATE.externalTempWasFresh = extTempFreshNow;

  if (d.state === MACHINE.FAULT) {
    applyDecision(ts, d);
    publishFault("AIR_SENSOR_MISSING", "critical", "Local air sensor unavailable; outputs forced off");
  } else {
    applyDecision(ts, d);
  }

  publishState(ts, d, STATE.forcePublishState);
  STATE.forcePublishState = false;
}

// ---------- MQTT publication ----------

function mqttPublish(subTopic, obj, retain) {
  if (typeof MQTT === "undefined") return;
  MQTT.publish(
    CONFIG.mqttPrefix + "/" + CONFIG.haObjectId + "/" + subTopic,
    JSON.stringify(obj),
    0,
    !!retain
  );
}

function mqttRet(topic, obj) {
  if (typeof MQTT === "undefined") return;
  MQTT.publish(topic, JSON.stringify(obj), 0, true);
}

function mqttRetEmpty(topic) {
  if (typeof MQTT === "undefined") return;
  MQTT.publish(topic, "", 0, true);
}

function publishFault(code, severity, message) {
  STATE.lastFaultCode = code;
  mqttPublish(
    "fault",
    {
      code: code,
      severity: severity,
      message: message,
      ts: nowS()
    },
    false
  );
}

function publishState(ts, d, force) {
  if (!force && (ts - STATE.lastPublishedAt) * 1000 < CONFIG.mqttPublishMs) return;
  STATE.lastPublishedAt = ts;

  var hasPD = okNum(d.plateC) && okNum(d.dewC);
  var plateMinusDew = hasPD ? d.plateC - d.dewC : null;
  var condensingNow = hasPD ? d.plateC < d.dewC : false;

  mqttPublish(
    "state",
    {
      enabled: STATE.enabled,
      target_humidity_rh: STATE.humiditySetpointEffectiveRh,
      target_humidity_requested_rh: STATE.humiditySetpointRh,
      mode: d.mode,

      machine_state: STATE.machineState,
      cool_reason: STATE.coolReason,
      heat_reason: STATE.heatReason,
      simultaneous_mode_active: d.allowSim,

      air_c: d.airC,
      plate_c: d.plateC,
      control_temp_c: d.controlTempC,
      humidity_rh: d.humidityRh,

      humidity_control_available: d.humidityControlAvailable,
      humidity_demand_active: d.humidityDemandActive,
      drying_mode_requested: d.dryingModeRequested,
      drying_block_reason: d.dryingBlockReason,
      humidity_mode: d.humidityMode,
      dehum_active: STATE.dehumActive,

      dew_temp_source: d.dewTempSource,
      dew_point_c: d.dewC,
      plate_target_c: d.plateTargetC,
      plate_minus_dew_c: plateMinusDew,
      condensing_now: condensingNow,

      external_temp_fresh: fresh(STATE.externalTempC, ts, STATE.externalTempTs, CONFIG.tempStaleS),
      external_humidity_fresh: fresh(
        STATE.externalHumidityRh,
        ts,
        STATE.externalHumidityTs,
        CONFIG.humidityStaleS
      ),

      cool_on: STATE.coolOn,
      heat_on: STATE.heatOn,
      lockout_remaining_s: Math.max(0, STATE.coolingLockoutUntil - ts),

      plate_too_cold_latch: STATE.plateTooColdLatch,
      air_too_cold_for_cooling_latch: STATE.airTooColdForCoolingLatch,
      drying_overtemp_suspend: STATE.dryingOvertempSuspend,

      cycle_stop_reason: STATE.cycleStopReason,
      last_plate_event: STATE.lastPlateEvent,
      decision: STATE.lastDecision,
      fault: STATE.lastFaultCode,
      ts: ts
    },
    true
  );
}

// ---------- Home Assistant discovery ----------

function dt(component, key) {
  return "homeassistant/" + component + "/" + CONFIG.haObjectId + "_" + key + "/config";
}

function dbg(action, topic, payload) {
  if (typeof MQTT === "undefined" || !CONFIG.discoveryDebugEnabled) return;
  MQTT.publish(
    CONFIG.mqttPrefix + "/" + CONFIG.haObjectId + "/" + CONFIG.discoveryDebugTopicSuffix,
    JSON.stringify({
      action: action,
      discovery_topic: topic,
      payload: payload,
      ts: nowS()
    }),
    0,
    false
  );
}

function dev() {
  return {
    identifiers: [CONFIG.haObjectId],
    name: "Cave Saucisson Controller",
    manufacturer: "Custom",
    model: "Shelly Script"
  };
}

function pubCfg(component, key, payload) {
  var merged = {
    unique_id: CONFIG.haObjectId + "_" + key,
    device: dev()
  };

  var k;
  for (k in payload) {
    if (payload[k] !== null && typeof payload[k] !== "undefined") merged[k] = payload[k];
  }

  var topic = dt(component, key);
  dbg("publish", topic, merged);
  mqttRet(topic, merged);
}

function purgeDiscovery() {
  var entries = [
    ["humidifier", "humidifier"],
    ["sensor", "air_temperature"],
    ["sensor", "plate_temperature"],
    ["sensor", "humidity"],
    ["sensor", "machine_state"],
    ["sensor", "fault"],
    ["sensor", "dew_point"],
    ["sensor", "plate_target"],
    ["sensor", "plate_minus_dew"],
    ["binary_sensor", "condensing_now"],
    ["climate", "climate"]
  ];

  var i;
  for (i = 0; i < entries.length; i++) {
    var topic = dt(entries[i][0], entries[i][1]);
    mqttRetEmpty(topic);
    dbg("purge", topic, null);
  }
}

function publishDiscovery() {
  var st = CONFIG.mqttPrefix + "/" + CONFIG.haObjectId + "/state";
  var base = CONFIG.mqttPrefix + "/" + CONFIG.haObjectId;

  pubCfg("humidifier", "humidifier", {
    name: "Cave Dehumidifier",
    device_class: "dehumidifier",
    state_topic: st,
    state_value_template: "{% if value_json.enabled %}auto{% else %}off{% endif %}",
    command_topic: base + "/set/mode",
    payload_on: "auto",
    payload_off: "off",
    mode_state_topic: st,
    mode_state_template: "{% if value_json.enabled %}auto{% else %}off{% endif %}",
    mode_command_topic: base + "/set/mode",
    modes: ["off", "auto"],
    action_topic: st,
    action_template: "{% if not value_json.enabled %}off{% elif value_json.dehum_active %}drying{% else %}idle{% endif %}",
    current_humidity_topic: st,
    current_humidity_template: "{{ value_json.humidity_rh | default(none) }}",
    target_humidity_state_topic: st,
    target_humidity_state_template: "{{ value_json.target_humidity_rh }}",
    target_humidity_command_topic: base + "/set/target_humidity"
  });

  pubCfg("sensor", "air_temperature", {
    name: "Cave Air Temperature",
    state_topic: st,
    value_template: "{{ value_json.air_c | default(none) }}",
    device_class: "temperature",
    unit_of_measurement: "°C"
  });

  pubCfg("sensor", "plate_temperature", {
    name: "Cave Plate Temperature",
    state_topic: st,
    value_template: "{{ value_json.plate_c | default(none) }}",
    device_class: "temperature",
    unit_of_measurement: "°C"
  });

  pubCfg("sensor", "humidity", {
    name: "Cave Humidity",
    state_topic: st,
    value_template: "{{ value_json.humidity_rh | default(none) }}",
    device_class: "humidity",
    unit_of_measurement: "%"
  });

  pubCfg("sensor", "machine_state", {
    name: "Cave Machine State",
    state_topic: st,
    value_template: "{{ value_json.machine_state | default(none) }}"
  });

  pubCfg("sensor", "fault", {
    name: "Cave Fault",
    state_topic: st,
    value_template: "{{ value_json.fault | default(none) }}"
  });

  if (!CONFIG.discoveryExtendedEnabled) return;

  pubCfg("sensor", "dew_point", {
    name: "Cave Dew Point",
    state_topic: st,
    value_template: "{{ value_json.dew_point_c | default(none) }}",
    device_class: "temperature",
    unit_of_measurement: "°C"
  });

  pubCfg("sensor", "plate_target", {
    name: "Cave Plate Target",
    state_topic: st,
    value_template: "{{ value_json.plate_target_c | default(none) }}",
    device_class: "temperature",
    unit_of_measurement: "°C"
  });

  pubCfg("sensor", "plate_minus_dew", {
    name: "Cave Plate Minus Dew",
    state_topic: st,
    value_template: "{{ value_json.plate_minus_dew_c | default(none) }}",
    unit_of_measurement: "°C"
  });

  pubCfg("binary_sensor", "condensing_now", {
    name: "Cave Condensing Now",
    state_topic: st,
    value_template: "{{ value_json.condensing_now | string | lower }}",
    payload_on: "true",
    payload_off: "false"
  });
}

// ---------- MQTT init ----------

function mqttInit() {
  if (typeof MQTT === "undefined") return;

  var base = CONFIG.mqttPrefix + "/" + CONFIG.haObjectId;

  MQTT.subscribe(CONFIG.externalTempTopic, function (_t, payload) {
    var n = parseNum(payload);
    if (!okNum(n)) return;
    STATE.externalTempC = n;
    STATE.externalTempTs = nowS();
  });

  MQTT.subscribe(CONFIG.externalHumidityTopic, function (_t, payload) {
    var n = parseNum(payload);
    if (!okNum(n) || n < 0 || n > 100) return;
    STATE.externalHumidityRh = n;
    STATE.externalHumidityTs = nowS();
  });

  MQTT.subscribe(base + "/set/mode", function (_t, payload) {
    if (payload === "off") STATE.enabled = false;
    else if (payload === "auto") STATE.enabled = true;
  });

  MQTT.subscribe(base + "/set/target_humidity", function (_t, payload) {
    var n = parseNum(payload);
    if (!okNum(n) || n < 0 || n > 100) return;
    STATE.humiditySetpointRh = n;
  });
}

// ---------- Démarrage sûr ----------

function bootstrap() {
  var ts = nowS();

  // Sécurité au boot: forcer matériellement les sorties à OFF.
  setSwitch(CONFIG.coolSwitchId, false);
  setSwitch(CONFIG.heatSwitchId, false);

  // Resynchronisation logiciel + lockout compresseur immédiat.
  STATE.coolOn = false;
  STATE.heatOn = false;
  STATE.coolingLockoutUntil = ts + CONFIG.lockoutS;
  STATE.lastDecision = "boot_force_off_sync";
  STATE.cycleStopReason = "boot_safe";
  STATE.lastPlateEvent = "none";

  mqttInit();
  var errs = configErrors();
  if (errs.length > 0) {
    STATE.machineState = MACHINE.FAULT;
    publishFault("CONFIG_INVALID", "critical", errs.join("; "));
    return;
  }

  purgeDiscovery();
  publishDiscovery();
  publishFault("BOOT", "info", "Controller started");

  // Exécution immédiate puis boucle périodique.
  loop();
  Timer.set(CONFIG.loopMs, true, loop);
}

bootstrap();
