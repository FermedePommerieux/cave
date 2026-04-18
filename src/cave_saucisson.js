/*
 * cave_saucisson.js
 * Script Shelly unique pour régulation cave à saucissons.
 * Sécurité prioritaire: jamais froid + chauffage simultanés.
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

  hardMaxAirC: 14.0,

  coolOnC: 13.0,
  coolOffC: 11.5,
  lockoutS: 180,

  heatOnC: 10.5,
  heatOffC: 11.5,
  heatDisableAboveC: 13.5,

  rhOn: 80.0,
  rhOff: 77.0,

  plateMinOffC: 0.0,
  plateMinResumeC: 3.0,

  dewTargetMarginC: 1.0,

  adaptiveCoolMaxInitialS: 240,
  adaptiveCoolMaxMinS: 120,
  adaptiveCoolMaxMaxS: 480,
  adaptiveCoolAdjustStepS: 15,

  loopMs: 5000,
  mqttPublishMs: 5000
};

var STATE = {
  enabled: CONFIG.defaultEnabled,
  tempSetpointC: CONFIG.defaultTempSetpointC,
  humiditySetpointRh: CONFIG.defaultHumiditySetpointRh,

  externalTempC: null,
  externalTempTs: 0,
  externalHumidityRh: null,
  externalHumidityTs: 0,

  coolOn: false,
  heatOn: false,

  coolingLockoutUntil: 0,
  coolingStartedAt: 0,
  adaptiveCoolMaxS: CONFIG.adaptiveCoolMaxInitialS,
  plateTooColdLatch: false,

  lastFaultCode: "none",
  lastPublishedAt: 0,
  lastDecision: "startup"
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

function applyOutputs(nextCool, nextHeat, reason) {
  // Invariant absolu: jamais simultanés.
  if (nextCool && nextHeat) {
    nextHeat = false;
    reason = reason + "|mutex";
  }

  if (STATE.coolOn !== nextCool) {
    setSwitch(CONFIG.coolSwitchId, nextCool);
    STATE.coolOn = nextCool;
    if (nextCool) {
      STATE.coolingStartedAt = nowS();
      STATE.lastDecision = "cool_on:" + reason;
    } else {
      STATE.coolingLockoutUntil = nowS() + CONFIG.lockoutS;
      STATE.lastDecision = "cool_off:" + reason;
    }
  }

  if (STATE.heatOn !== nextHeat) {
    setSwitch(CONFIG.heatSwitchId, nextHeat);
    STATE.heatOn = nextHeat;
    STATE.lastDecision = (nextHeat ? "heat_on:" : "heat_off:") + reason;
  }
}

function externalTempFresh(tsNow) {
  return isFiniteNumber(STATE.externalTempC) && (tsNow - STATE.externalTempTs) <= CONFIG.tempStaleS;
}

function externalHumidityFresh(tsNow) {
  return isFiniteNumber(STATE.externalHumidityRh) && (tsNow - STATE.externalHumidityTs) <= CONFIG.humidityStaleS;
}

function adjustAdaptiveCool(airC) {
  if (!isFiniteNumber(airC)) return;
  if (airC > CONFIG.hardMaxAirC) {
    STATE.adaptiveCoolMaxS = Math.min(CONFIG.adaptiveCoolMaxMaxS, STATE.adaptiveCoolMaxS + CONFIG.adaptiveCoolAdjustStepS);
    return;
  }
  if (airC < CONFIG.coolOffC) {
    STATE.adaptiveCoolMaxS = Math.max(CONFIG.adaptiveCoolMaxMinS, STATE.adaptiveCoolMaxS - CONFIG.adaptiveCoolAdjustStepS);
  }
}

function controlLoop() {
  var ts = nowS();
  var airC = readTempC(CONFIG.localAirTempSensorId);
  var plateC = readTempC(CONFIG.localPlateTempSensorId);

  if (!isFiniteNumber(airC)) {
    applyOutputs(false, false, "air_missing");
    publishFault("AIR_SENSOR_MISSING", "critical", "Local air sensor unavailable; outputs forced off");
    publishState(ts, airC, plateC, null, null, "safe_stop");
    return;
  }

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
  var wantCool = false;
  var wantHeat = false;

  // Sécurité plaque froide prioritaire.
  if (!isFiniteNumber(plateC)) {
    publishFault("PLATE_SENSOR_MISSING", "warning", "Plate sensor unavailable; cooling blocked");
  } else {
    if (plateC <= CONFIG.plateMinOffC) {
      STATE.plateTooColdLatch = true;
    } else if (plateC >= CONFIG.plateMinResumeC) {
      STATE.plateTooColdLatch = false;
    }
  }

  // Chauffage: protection basse température uniquement.
  if (controlTempC <= CONFIG.heatOnC) {
    wantHeat = true;
  }
  if (controlTempC >= CONFIG.heatOffC || controlTempC >= CONFIG.heatDisableAboveC) {
    wantHeat = false;
  }

  // Froid: température et éventuellement humidité, sans jamais forcer le chauffage.
  if (controlTempC >= CONFIG.coolOnC) {
    wantCool = true;
  }
  if (controlTempC <= CONFIG.coolOffC) {
    wantCool = false;
  }

  if (humidityRh !== null) {
    if (humidityRh >= CONFIG.rhOn) wantCool = true;
    if (humidityRh <= CONFIG.rhOff && controlTempC <= CONFIG.tempSetpointC + CONFIG.dewTargetMarginC) {
      wantCool = false;
    }
  }

  // Hard max ambiance: on pousse vers refroidissement si possible.
  if (airC > CONFIG.hardMaxAirC) {
    wantCool = true;
    wantHeat = false;
  }

  // Inhibitions de sécurité sur le froid.
  if (STATE.plateTooColdLatch || !isFiniteNumber(plateC)) {
    wantCool = false;
  }
  if (ts < STATE.coolingLockoutUntil && !STATE.coolOn) {
    wantCool = false;
  }
  if (STATE.coolOn && (ts - STATE.coolingStartedAt) > STATE.adaptiveCoolMaxS) {
    wantCool = false;
  }

  // Invariant sécurité mutuelle.
  if (wantHeat) {
    wantCool = false;
  }

  applyOutputs(wantCool, wantHeat, mode);

  adjustAdaptiveCool(airC);
  publishState(ts, airC, plateC, controlTempC, humidityRh, mode);
}

function publishState(ts, airC, plateC, controlTempC, humidityRh, mode) {
  if ((ts - STATE.lastPublishedAt) * 1000 < CONFIG.mqttPublishMs) return;
  STATE.lastPublishedAt = ts;

  mqttPublish("state", {
    enabled: STATE.enabled,
    mode: mode,
    air_c: airC,
    plate_c: plateC,
    control_temp_c: controlTempC,
    external_temp_fresh: externalTempFresh(ts),
    external_humidity_fresh: externalHumidityFresh(ts),
    humidity_rh: humidityRh,
    cool_on: STATE.coolOn,
    heat_on: STATE.heatOn,
    adaptive_cool_max_s: STATE.adaptiveCoolMaxS,
    lockout_remaining_s: Math.max(0, STATE.coolingLockoutUntil - ts),
    plate_too_cold_latch: STATE.plateTooColdLatch,
    decision: STATE.lastDecision,
    fault: STATE.lastFaultCode,
    ts: ts
  });
}

function mqttInit() {
  if (typeof MQTT === "undefined") return;

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
}

function bootstrap() {
  applyOutputs(false, false, "boot_safe");
  mqttInit();
  Timer.set(CONFIG.loopMs, true, controlLoop);
  publishFault("BOOT", "info", "Controller started");
}

bootstrap();
