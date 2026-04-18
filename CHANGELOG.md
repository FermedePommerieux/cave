# Changelog

Tous les changements notables de ce projet seront documentés dans ce fichier.

Le format s'inspire de Keep a Changelog et suit SemVer quand pertinent.

## [0.2.4] - 2026-04-18

### Changed
- Fiabilisation du cycle Discovery Home Assistant: tentative uniquement si MQTT est connecté, retry depuis la boucle de contrôle jusqu'au premier succès, puis verrouillage via `STATE.discoveryDone`.
- Topic dédié `.../current` de l'entité humidifier: publication retained de la valeur RH si disponible, sinon publication retained de `None` pour réinitialiser la valeur côté Home Assistant.
- Bootstrap simplifié: suppression de la publication discovery au démarrage, désormais gérée par la boucle avec garde de connexion MQTT.

## [0.2.3] - 2026-04-18

### Changed
- Discovery MQTT Home Assistant `humidifier` migré vers un pattern robuste à topics dédiés (`mode/state`, `target/state`, `current`, `action`) sans templates JSON.
- Ajout des commandes MQTT dédiées `mode/set` (`1|0`) et `target/set` (`0..100`) pour l'entité humidifier, en conservant les topics historiques `set/mode` et `set/target_humidity`.
- Nettoyage retained ajouté pour supprimer l'ancienne discovery humidifier (`homeassistant/humidifier/cave_saucisson_humidifier/config`) avant publication de la nouvelle discovery.

## [0.2.2] - 2026-04-18

### Changed
- Discovery MQTT Home Assistant corrigé pour l'entité `humidifier` avec `command_topic` (`set/power`) + `payload_on/off`, tout en conservant `mode` (`off|auto`) et la cible d'humidité.
- Publication Discovery complétée pour toutes les télémétries actuelles `sensor` et `binary_sensor` exposées dans le JSON `state`.
- Ajout de la commande MQTT `set/power` (`ON|OFF`) en complément de `set/mode` (`off|auto`) pour un contrôle HA explicite de `enabled`.
- Ajout d'un nettoyage de compatibilité via publication retained vide sur `homeassistant/climate/<haObjectId>_climate/config`.

## [0.2.1] - 2026-04-18

### Added
- Télémétrie MQTT humidité explicite dans `state`: `humidity_control_available`, `humidity_demand_active`, `drying_mode_requested`, `drying_block_reason`, `humidity_mode`.
- Home Assistant MQTT Discovery (retained, préfixe `homeassistant`) pour 1 humidifier + capteurs/binary sensors depuis le topic JSON `state`.
- Commandes MQTT minimales pour l'entité humidifier: `set/mode` (`off|auto`) et `set/target_humidity` (`0..100`).
- Champ `target_humidity_rh` publié dans `state`.

## [0.2.0] - 2026-04-18

### Changed
- Refactor de la régulation en machine à états (`IDLE`, `COOLING`, `POST_COOL_INERTIA`, `HEATING`, `DRYING_ACTIVE`, `FAULT`).
- Introduction d'une régulation à deux niveaux : air cave + plaque de condensation.
- Autorisation contrôlée du simultané chauffage+froid uniquement en `DRYING_ACTIVE`.
- Pilotage compresseur sur cible plaque dérivée du point de rosée quand l'humidité est valide.
- Apprentissage de runtime compresseur basé sur inertie post-arrêt et overshoot plaque.
- Priorité renforcée de `POST_COOL_INERTIA` : aucune reprise chauffage/froid avant fin de suivi inertiel.
- Fin d'inertie améliorée: sortie possible sur stabilité des minima (`plate_stable`) via `postCoolMinDeltaC` + `postCoolStableWindowS`, avec timeout raccourci.
- Télémetrie d'arrêt compresseur clarifiée avec trois champs distincts: `cycle_stop_reason`, `last_plate_event`, `last_post_cool_finalize_reason`.
- Priorité hard-max ambiance ajoutée: suspension de `DRYING_ACTIVE` à `airC >= hardMaxAirC` et reprise sous `dryingResumeBelowHardMaxC`.

### Added
- Nouvelle télémétrie MQTT de diagnostic: état machine, raisons chaud/froid, point de rosée, cible plaque, overshoot et runtime appris.

## [0.1.0] - 2026-04-18

### Added
- Initialisation complète du dépôt.
- Script Shelly unique `src/cave_saucisson.js` pour pilotage cave à saucissons.
- Documentation d'architecture, mise en service et MQTT.
- Fichiers de gouvernance (contribution, sécurité, modèles GitHub).
