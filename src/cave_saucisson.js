/* cave_saucisson.js - V2 KISS recentré métier (hors MQTT: logique courte) */

var CONFIG = {
  mqttPrefix: "fdp_communs_cave_saucissons", haObjectId: "cave_saucisson",
  localAirTempSensorId: 100, localPlateTempSensorId: 101, coolSwitchId: 0, heatSwitchId: 1,
  externalTempTopic: "fdp_communs_cave_saucissons/thermostat/external_temperature",
  externalHumidityTopic: "fdp_communs_cave_saucissons/thermostat/external_humidity",
  tempStaleS: 900, humidityStaleS: 10800,
  defaultEnabled: true, defaultHumiditySetpointRh: 78.0,
  humiditySetpointHysteresisRh: 3.0, humiditySetpointMinRh: 60.0, humiditySetpointMaxRh: 90.0,
  coolOnC: 13.0, coolOffC: 11.5, heatOnC: 10.5, heatOffC: 11.5, heatDisableAboveC: 13.5,
  hardMaxAirC: 14.0, dryingResumeBelowHardMaxC: 13.5,
  dryingAirSetpointC: 12.0, dryingAirHysteresisC: 0.6,
  lockoutS: 180, plateMinOffC: 0.0, plateMinResumeC: 3.0,
  dewTargetMarginC: 1.0, plateTargetHysteresisC: 0.6, dewPointTempSource: "local_air",
  loopMs: 5000, mqttPublishMs: 5000, discoveryExtendedEnabled: false, discoveryDebugEnabled: false,
  discoveryDebugTopicSuffix: "debug/discovery_payload"
};

var MACHINE = { IDLE: "IDLE", COOLING: "COOLING", HEATING: "HEATING", DRYING_ACTIVE: "DRYING_ACTIVE", FAULT: "FAULT" };
var STATE = {
  enabled: CONFIG.defaultEnabled, humiditySetpointRh: CONFIG.defaultHumiditySetpointRh, humiditySetpointEffectiveRh: CONFIG.defaultHumiditySetpointRh,
  externalTempC: null, externalTempTs: 0, externalHumidityRh: null, externalHumidityTs: 0,
  coolOn: false, heatOn: false, coolingLockoutUntil: 0,
  plateTooColdLatch: false, airTooColdForCoolingLatch: false, dryingOvertempSuspend: false,
  machineState: MACHINE.IDLE, coolReason: "none", heatReason: "none", cycleStopReason: "none", lastPlateEvent: "none", lastDecision: "startup", lastFaultCode: "none",
  dehumActive: false, lastPublishedAt: 0
};

function nowS(){var s=Shelly.getComponentStatus("sys");return(s&&typeof s.unixtime==="number"&&s.unixtime>0)?s.unixtime:Math.floor(Date.now()/1000);} 
function okNum(v){return typeof v==="number"&&isFinite(v);} function clamp(v,a,b){return v<a?a:(v>b?b:v);} 
function readTempC(id){var st=Shelly.getComponentStatus("temperature:"+id);if(!st)return null;return okNum(st.tC)?st.tC:(okNum(st.value)?st.value:null);} 
function parseNum(p){if(typeof p==="number")return p;if(typeof p!=="string")return null;var n=Number(p);return okNum(n)?n:null;} 
function fresh(v,ts,last,maxAge){return okNum(v)&&(ts-last)<=maxAge;} 
function dewPointC(t,h){if(!okNum(t)||!okNum(h)||h<=0||h>100)return null;var a=17.62,b=243.12,g=Math.log(h/100)+(a*t)/(b+t);return (b*g)/(a-g);} 
function setSwitch(id,on){Shelly.call("Switch.Set",{id:id,on:on});}

// ----------- Logique métier (cible: ~100 lignes, hors MQTT/discovery) -----------
function computeDecision(ts){
  var airC=readTempC(CONFIG.localAirTempSensorId), plateC=readTempC(CONFIG.localPlateTempSensorId);
  var extTempOk=fresh(STATE.externalTempC,ts,STATE.externalTempTs,CONFIG.tempStaleS), extHumOk=fresh(STATE.externalHumidityRh,ts,STATE.externalHumidityTs,CONFIG.humidityStaleS);
  var controlTempC=extTempOk?STATE.externalTempC:airC, humidityRh=extHumOk?STATE.externalHumidityRh:null;
  var dewTempC=(CONFIG.dewPointTempSource==="external_if_fresh"&&extTempOk)?STATE.externalTempC:airC;
  var dewTempSource=(CONFIG.dewPointTempSource==="external_if_fresh"&&extTempOk)?"external_fresh":"local_air";
  var dewC=extHumOk?dewPointC(dewTempC,humidityRh):null, plateTargetC=okNum(dewC)?(dewC-CONFIG.dewTargetMarginC):null;

  if(!okNum(airC)) return {airC:airC,plateC:plateC,controlTempC:controlTempC,humidityRh:humidityRh,dewC:dewC,plateTargetC:plateTargetC,dewTempSource:dewTempSource,mode:extHumOk?"temp+humidity":"temp_only",state:MACHINE.FAULT,wantCool:false,wantHeat:false,allowSim:false,coolReason:"air_sensor_missing",heatReason:"air_sensor_missing",humidityControlAvailable:extHumOk,humidityDemandActive:false,dryingModeRequested:false,dryingBlockReason:"humidity_stale",humidityMode:"not_available"};

  if(okNum(plateC)){if(plateC<=CONFIG.plateMinOffC)STATE.plateTooColdLatch=true;else if(plateC>=CONFIG.plateMinResumeC)STATE.plateTooColdLatch=false;} else publishFault("PLATE_SENSOR_MISSING","warning","Plate sensor unavailable; cooling blocked");
  if(airC<=CONFIG.heatOnC)STATE.airTooColdForCoolingLatch=true;else if(airC>=CONFIG.heatOffC)STATE.airTooColdForCoolingLatch=false;

  var coolingBlocked=!okNum(plateC)||STATE.plateTooColdLatch||STATE.airTooColdForCoolingLatch;
  var coolingBlockReason=STATE.airTooColdForCoolingLatch?"air_too_cold_block":"plate_safety_block";
  var lockout=ts<STATE.coolingLockoutUntil&&!STATE.coolOn;
  var heatDemand=STATE.heatOn?(controlTempC<CONFIG.heatOffC&&controlTempC<CONFIG.heatDisableAboveC):(controlTempC<=CONFIG.heatOnC&&controlTempC<CONFIG.heatDisableAboveC);
  var coolDemand=STATE.coolOn?(controlTempC>CONFIG.coolOffC):(controlTempC>=CONFIG.coolOnC);

  var hardMax=airC>=CONFIG.hardMaxAirC;
  if(hardMax){coolDemand=true;heatDemand=false;STATE.dryingOvertempSuspend=true;} else if(STATE.dryingOvertempSuspend&&airC<=CONFIG.dryingResumeBelowHardMaxC) STATE.dryingOvertempSuspend=false;

  var rhSp=clamp(STATE.humiditySetpointRh,CONFIG.humiditySetpointMinRh,CONFIG.humiditySetpointMaxRh); STATE.humiditySetpointEffectiveRh=rhSp;
  var halfRh=CONFIG.humiditySetpointHysteresisRh/2.0,rhOn=rhSp+halfRh,rhOff=rhSp-halfRh; if(rhOff>=rhOn)rhOff=rhOn-0.1;
  var dryingDemand=(!STATE.dryingOvertempSuspend&&extHumOk)?((STATE.machineState===MACHINE.DRYING_ACTIVE)?(humidityRh>rhOff):(humidityRh>=rhOn)):false;
  var humidityMode=extHumOk?"external_valid":(okNum(STATE.externalHumidityRh)?"external_stale":"not_available");
  var dryingBlockReason=!extHumOk?"humidity_stale":(STATE.dryingOvertempSuspend?"overtemp_suspend":(!dryingDemand?"no_humidity_request":(!okNum(plateTargetC)?"no_plate_target":"none")));

  var d={airC:airC,plateC:plateC,controlTempC:controlTempC,humidityRh:humidityRh,dewC:dewC,plateTargetC:plateTargetC,dewTempSource:dewTempSource,mode:extHumOk?"temp+humidity":"temp_only",
    state:MACHINE.IDLE,wantCool:false,wantHeat:false,allowSim:false,coolReason:"no_demand",heatReason:"no_demand",
    humidityControlAvailable:extHumOk,humidityDemandActive:dryingDemand,dryingModeRequested:dryingDemand&&extHumOk&&okNum(plateTargetC),dryingBlockReason:dryingBlockReason,humidityMode:humidityMode};

  if(!STATE.enabled){d.coolReason="disabled";d.heatReason="disabled";return d;}
  if(hardMax||STATE.dryingOvertempSuspend){d.state=MACHINE.COOLING;d.heatReason="hardmax_override";if(coolingBlocked)d.coolReason=coolingBlockReason;else if(lockout)d.coolReason="lockout";else{d.wantCool=true;d.coolReason=hardMax?"hardmax_protection":"hardmax_recovery";}return d;}
  if(dryingDemand&&extHumOk&&okNum(plateTargetC)){d.state=MACHINE.DRYING_ACTIVE;d.allowSim=true;var hb=CONFIG.dryingAirHysteresisC/2.0,hOn=CONFIG.dryingAirSetpointC-hb,hOff=CONFIG.dryingAirSetpointC+hb;d.wantHeat=STATE.heatOn?(airC<hOff):(airC<=hOn);d.heatReason=d.wantHeat?"dehum_comp_forced_below_setpoint":"dehum_comp_not_needed";if(coolingBlocked)d.coolReason=coolingBlockReason;else if(lockout)d.coolReason="lockout";else{var ph=CONFIG.plateTargetHysteresisC/2.0,pOn=plateTargetC+ph,pOff=plateTargetC-ph;d.wantCool=STATE.coolOn?(plateC>pOff):(plateC>=pOn);d.coolReason=d.wantCool?"drying_plate_target":"drying_plate_hysteresis";}return d;}
  if(heatDemand){d.state=MACHINE.HEATING;d.wantHeat=true;d.coolReason="heating_priority";d.heatReason="low_temp_protection";return d;}
  if(coolDemand){d.state=MACHINE.COOLING;d.heatReason="none";if(coolingBlocked)d.coolReason=coolingBlockReason;else if(lockout)d.coolReason="lockout";else{d.wantCool=true;d.coolReason="thermal_demand";}return d;}
  return d;
}

function applyDecision(ts,d){
  if(d.wantCool&&d.wantHeat&&!d.allowSim){d.wantHeat=false;d.coolReason=d.coolReason+"|mutex";}
  if(STATE.coolOn!==d.wantCool){setSwitch(CONFIG.coolSwitchId,d.wantCool);STATE.coolOn=d.wantCool;STATE.lastDecision=(d.wantCool?"cool_on:":"cool_off:")+d.state+":"+d.coolReason+":"+d.heatReason;if(!d.wantCool)STATE.coolingLockoutUntil=ts+CONFIG.lockoutS;else{STATE.cycleStopReason="none";STATE.lastPlateEvent="none";}}
  if(STATE.heatOn!==d.wantHeat){setSwitch(CONFIG.heatSwitchId,d.wantHeat);STATE.heatOn=d.wantHeat;STATE.lastDecision=(d.wantHeat?"heat_on:":"heat_off:")+d.state+":"+d.coolReason+":"+d.heatReason;}
  if(STATE.coolOn&&!d.wantCool)STATE.cycleStopReason=d.coolReason;
  STATE.machineState=d.state;STATE.coolReason=d.coolReason;STATE.heatReason=d.heatReason;STATE.dehumActive=(d.state===MACHINE.DRYING_ACTIVE);
}

function loop(){
  var ts=nowS(),d=computeDecision(ts);
  if(!d.humidityControlAvailable&&okNum(STATE.externalHumidityRh))publishFault("EXTERNAL_HUMIDITY_STALE","info","External humidity stale; switching to temperature-only mode");
  if(!fresh(STATE.externalTempC,ts,STATE.externalTempTs,CONFIG.tempStaleS)&&okNum(STATE.externalTempC))publishFault("EXTERNAL_TEMP_STALE","info","External temperature stale; fallback to local air sensor");
  if(d.state===MACHINE.FAULT){applyDecision(ts,d);publishFault("AIR_SENSOR_MISSING","critical","Local air sensor unavailable; outputs forced off");}
  else applyDecision(ts,d);
  publishState(ts,d);
}

// ---------------- MQTT / Discovery / publication ----------------
function mqttPublish(sub,obj,retain){if(typeof MQTT==="undefined")return;MQTT.publish(CONFIG.mqttPrefix+"/"+CONFIG.haObjectId+"/"+sub,JSON.stringify(obj),0,!!retain);} 
function mqttRet(topic,obj){if(typeof MQTT==="undefined")return;MQTT.publish(topic,JSON.stringify(obj),0,true);} 
function mqttRetEmpty(topic){if(typeof MQTT==="undefined")return;MQTT.publish(topic,"",0,true);} 
function publishFault(code,severity,message){STATE.lastFaultCode=code;mqttPublish("fault",{code:code,severity:severity,message:message,ts:nowS()},false);} 

function publishState(ts,d){
  if((ts-STATE.lastPublishedAt)*1000<CONFIG.mqttPublishMs)return; STATE.lastPublishedAt=ts;
  var hasPD=okNum(d.plateC)&&okNum(d.dewC),plateMinusDew=hasPD?(d.plateC-d.dewC):null,condensingNow=hasPD?(d.plateC<d.dewC):false;
  mqttPublish("state",{
    enabled:STATE.enabled,target_humidity_rh:STATE.humiditySetpointEffectiveRh,target_humidity_requested_rh:STATE.humiditySetpointRh,mode:d.mode,
    machine_state:STATE.machineState,cool_reason:STATE.coolReason,heat_reason:STATE.heatReason,simultaneous_mode_active:d.allowSim,
    air_c:d.airC,plate_c:d.plateC,control_temp_c:d.controlTempC,humidity_rh:d.humidityRh,
    humidity_control_available:d.humidityControlAvailable,humidity_demand_active:d.humidityDemandActive,drying_mode_requested:d.dryingModeRequested,drying_block_reason:d.dryingBlockReason,humidity_mode:d.humidityMode,dehum_active:STATE.dehumActive,
    dew_temp_source:d.dewTempSource,dew_point_c:d.dewC,plate_target_c:d.plateTargetC,plate_minus_dew_c:plateMinusDew,condensing_now:condensingNow,
    external_temp_fresh:fresh(STATE.externalTempC,ts,STATE.externalTempTs,CONFIG.tempStaleS),external_humidity_fresh:fresh(STATE.externalHumidityRh,ts,STATE.externalHumidityTs,CONFIG.humidityStaleS),
    cool_on:STATE.coolOn,heat_on:STATE.heatOn,lockout_remaining_s:Math.max(0,STATE.coolingLockoutUntil-ts),
    plate_too_cold_latch:STATE.plateTooColdLatch,air_too_cold_for_cooling_latch:STATE.airTooColdForCoolingLatch,drying_overtemp_suspend:STATE.dryingOvertempSuspend,
    cycle_stop_reason:STATE.cycleStopReason,last_plate_event:STATE.lastPlateEvent,decision:STATE.lastDecision,fault:STATE.lastFaultCode,ts:ts
  },true);
}

function dt(c,k){return "homeassistant/"+c+"/"+CONFIG.haObjectId+"_"+k+"/config";} 
function dbg(action,topic,payload){if(typeof MQTT==="undefined"||!CONFIG.discoveryDebugEnabled)return;MQTT.publish(CONFIG.mqttPrefix+"/"+CONFIG.haObjectId+"/"+CONFIG.discoveryDebugTopicSuffix,JSON.stringify({action:action,discovery_topic:topic,payload:payload,ts:nowS()}),0,false);} 
function dev(){return{identifiers:[CONFIG.haObjectId],name:"Cave Saucisson Controller",manufacturer:"Custom",model:"Shelly Script"};}
function pubCfg(c,k,p){var m={unique_id:CONFIG.haObjectId+"_"+k,device:dev()},x;for(x in p)if(p[x]!==null&&typeof p[x]!=="undefined")m[x]=p[x];var t=dt(c,k);dbg("publish",t,m);mqttRet(t,m);} 
function purgeDiscovery(){var e=[["humidifier","humidifier"],["sensor","air_temperature"],["sensor","plate_temperature"],["sensor","humidity"],["sensor","machine_state"],["sensor","fault"],["sensor","dew_point"],["sensor","plate_target"],["sensor","plate_minus_dew"],["binary_sensor","condensing_now"],["climate","climate"]],i,t;for(i=0;i<e.length;i++){t=dt(e[i][0],e[i][1]);mqttRetEmpty(t);dbg("purge",t,null);}}
function publishDiscovery(){
  var st=CONFIG.mqttPrefix+"/"+CONFIG.haObjectId+"/state",base=CONFIG.mqttPrefix+"/"+CONFIG.haObjectId;
  pubCfg("humidifier","humidifier",{name:"Cave Dehumidifier",device_class:"dehumidifier",state_topic:st,state_value_template:"{% if value_json.enabled %}auto{% else %}off{% endif %}",command_topic:base+"/set/mode",payload_on:"auto",payload_off:"off",mode_state_topic:st,mode_state_template:"{% if value_json.enabled %}auto{% else %}off{% endif %}",mode_command_topic:base+"/set/mode",modes:["off","auto"],action_topic:st,action_template:"{% if not value_json.enabled %}off{% elif value_json.dehum_active %}drying{% else %}idle{% endif %}",current_humidity_topic:st,current_humidity_template:"{{ value_json.humidity_rh | default(none) }}",target_humidity_state_topic:st,target_humidity_state_template:"{{ value_json.target_humidity_rh }}",target_humidity_command_topic:base+"/set/target_humidity"});
  pubCfg("sensor","air_temperature",{name:"Cave Air Temperature",state_topic:st,value_template:"{{ value_json.air_c | default(none) }}",device_class:"temperature",unit_of_measurement:"°C"});
  pubCfg("sensor","plate_temperature",{name:"Cave Plate Temperature",state_topic:st,value_template:"{{ value_json.plate_c | default(none) }}",device_class:"temperature",unit_of_measurement:"°C"});
  pubCfg("sensor","humidity",{name:"Cave Humidity",state_topic:st,value_template:"{{ value_json.humidity_rh | default(none) }}",device_class:"humidity",unit_of_measurement:"%"});
  pubCfg("sensor","machine_state",{name:"Cave Machine State",state_topic:st,value_template:"{{ value_json.machine_state | default(none) }}"});
  pubCfg("sensor","fault",{name:"Cave Fault",state_topic:st,value_template:"{{ value_json.fault | default(none) }}"});
  if(!CONFIG.discoveryExtendedEnabled)return;
  pubCfg("sensor","dew_point",{name:"Cave Dew Point",state_topic:st,value_template:"{{ value_json.dew_point_c | default(none) }}",device_class:"temperature",unit_of_measurement:"°C"});
  pubCfg("sensor","plate_target",{name:"Cave Plate Target",state_topic:st,value_template:"{{ value_json.plate_target_c | default(none) }}",device_class:"temperature",unit_of_measurement:"°C"});
  pubCfg("sensor","plate_minus_dew",{name:"Cave Plate Minus Dew",state_topic:st,value_template:"{{ value_json.plate_minus_dew_c | default(none) }}",unit_of_measurement:"°C"});
  pubCfg("binary_sensor","condensing_now",{name:"Cave Condensing Now",state_topic:st,value_template:"{{ value_json.condensing_now | string | lower }}",payload_on:"true",payload_off:"false"});
}

function mqttInit(){
  if(typeof MQTT==="undefined")return; var base=CONFIG.mqttPrefix+"/"+CONFIG.haObjectId;
  MQTT.subscribe(CONFIG.externalTempTopic,function(_t,p){var n=parseNum(p);if(!okNum(n))return;STATE.externalTempC=n;STATE.externalTempTs=nowS();});
  MQTT.subscribe(CONFIG.externalHumidityTopic,function(_t,p){var n=parseNum(p);if(!okNum(n)||n<0||n>100)return;STATE.externalHumidityRh=n;STATE.externalHumidityTs=nowS();});
  MQTT.subscribe(base+"/set/mode",function(_t,p){if(p==="off")STATE.enabled=false;else if(p==="auto")STATE.enabled=true;});
  MQTT.subscribe(base+"/set/target_humidity",function(_t,p){var n=parseNum(p);if(!okNum(n)||n<0||n>100)return;STATE.humiditySetpointRh=n;});
}

function bootstrap(){
  var ts=nowS(); setSwitch(CONFIG.coolSwitchId,false); setSwitch(CONFIG.heatSwitchId,false);
  STATE.coolOn=false; STATE.heatOn=false; STATE.coolingLockoutUntil=ts+CONFIG.lockoutS; STATE.lastDecision="boot_force_off_sync"; STATE.cycleStopReason="boot_safe"; STATE.lastPlateEvent="none";
  mqttInit(); purgeDiscovery(); publishDiscovery(); publishFault("BOOT","info","Controller started"); loop(); Timer.set(CONFIG.loopMs,true,loop);
}

bootstrap();
