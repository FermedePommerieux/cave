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

  rhOn: 80.0,
  rhOff: 77.0,

  plateMinOffC: 0.0,
  plateMinResumeC: 3.0,

  dewTargetMarginC: 1.0,
  plateTargetHysteresisC: 0.6,

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
  mqttPublishMs: 5000
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

  if (!isFiniteNumber(plateC)) {
    publishFault("PLATE_SENSOR_MISSING", "warning", "Plate sensor unavailable; cooling blocked");
  } else {
    if (plateC <= CONFIG.plateMinOffC) {
      STATE.plateTooColdLatch = true;
    } else if (plateC >= CONFIG.plateMinResumeC) {
      STATE.plateTooColdLatch = false;
    }
  }

  var dewC = extHumOk ? dewPointC(controlTempC, humidityRh) : null;
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

  var dryingDemand = false;
  if (!STATE.dryingOvertempSuspend && extHumOk) {
    if (STATE.machineState === MACHINE.DRYING_ACTIVE) {
      dryingDemand = humidityRh > CONFIG.rhOff;
    } else {
      dryingDemand = humidityRh >= CONFIG.rhOn;
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
    dew_point_c: dewC,
    plate_target_c: plateTargetC,
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
  applyOutputs(false, false, false, "boot_safe", null, null, nowS(), false);
  mqttInit();
  Timer.set(CONFIG.loopMs, true, controlLoop);
  publishFault("BOOT", "info", "Controller started");
}

bootstrap();
