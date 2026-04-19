# Mise en service (commissioning)

## 1) Vérifications avant mise sous tension

- Confirmer le câblage des relais :
  - `switch:0` -> compresseur
  - `switch:1` -> chauffage
- Vérifier protections électriques et section de câbles.
- Vérifier présence des sondes locales IDs 100 (air) et 101 (plaque).
- Vérifier circulation d'air autour des sondes (pas collées aux sources thermiques).

## 2) Préparation Shelly

- Mettre à jour firmware Shelly.
- Activer MQTT si utilisé.
- Créer un script et coller `src/cave_saucisson.js`.
- Ajuster `CONFIG` (topics, seuils, ids) avant premier démarrage.

## 3) Vérification des sondes

- Lire température air et plaque via interface Shelly.
- Contrôler cohérence avec thermomètre de référence.
- Si écart notable, corriger placement puis compenser au niveau consignes.

## 4) Vérification relais (à vide puis en charge)

- Test manuel ON/OFF de `switch:0` et `switch:1`.
- Valider qu'aucune activation simultanée n'est possible.
- Observer intensité/démarrage compresseur (bruit, temps de reprise).

## 5) Vérification MQTT

- Publier une température externe valide.
- Publier une humidité externe valide.
- Confirmer réception et prise en compte dans l'état publié.
- Couper publication RH > attendre péremption -> vérifier passage mode température seule.

## 6) Calibration initiale

- Démarrer avec valeurs par défaut.
- Observer 24 à 48h :
  - durée cycles froid
  - stabilité autour de 12 °C
  - fréquence chauffe (doit rester protection basse température)
- Ajuster prudemment :
  - `coolOnC` / `coolOffC`
  - `rhOn` / `rhOff`
  - `adaptiveCoolMax*`

## 7) Surveillance premiers cycles

- Vérifier absence de défauts critiques récurrents.
- Vérifier que plaque ne reste pas sous 0 °C.
- Vérifier qu'ambiance reste <= 14 °C la majorité du temps.
- Vérifier que chauffage et froid ne sont jamais ON ensemble.
