# Changelog

Tous les changements notables de ce projet seront documentés dans ce fichier.

Le format s'inspire de Keep a Changelog et suit SemVer quand pertinent.

## [0.2.1] - 2026-04-18

### Added
- Télémétrie MQTT humidité explicite dans `state`: `humidity_control_available`, `humidity_demand_active`, `drying_mode_requested`, `drying_block_reason`, `humidity_mode`.

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
