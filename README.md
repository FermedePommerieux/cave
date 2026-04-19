# Cave à saucissons - Shelly Script

Projet embarqué minimal pour piloter une cave à saucissons avec un **script Shelly unique** (`src/cave_saucisson.js`).

## Objectif

Maintenir des conditions stables pour l'affinage en donnant la priorité à la sécurité thermique :

- température cible de cave (consigne par défaut 12.0 °C)
- plafond ambiance à 14.0 °C si possible
- prévention du gel (plaque froide)
- jamais chauffage et froid simultanés
- déshumidification uniquement par condensation sur plaque froide
- mode dégradé automatique si capteurs MQTT externes invalides

## Matériel visé

- 1x Shelly compatible Shelly Script (Gen2/Gen3)
- 2 sorties relais :
  - `switch:0` = compresseur froid
  - `switch:1` = chauffage (lampe/résistance)
- 2 sondes locales de température (Shelly Add-on / périphériques compatibles)
  - `temperature:100` = air cave
  - `temperature:101` = plaque froide
- Broker MQTT (optionnel mais recommandé)

## Capteurs / actionneurs

### Entrées

- Température air locale (obligatoire)
- Température plaque locale (obligatoire pour régulation froide sûre)
- Température externe MQTT (optionnelle, fallback sur sonde air locale)
- Humidité externe MQTT (optionnelle, sinon mode température seule)

### Sorties

- Relais froid (compresseur)
- Relais chauffage
- Télémétrie MQTT d'état et de défauts

## Topics MQTT

Voir `docs/mqtt-topics.md` pour le détail complet.

- Consommés :
  - `fdp_communs_cave_saucissons/thermostat/external_temperature`
  - `fdp_communs_cave_saucissons/thermostat/external_humidity`
- Publiés (exemples) :
  - `fdp_communs_cave_saucissons/cave_saucisson/state`
  - `fdp_communs_cave_saucissons/cave_saucisson/fault`

## Fonctionnement général

1. Lecture des sondes locales.
2. Mise à jour éventuelle des mesures externes MQTT.
3. Vérifications de sécurité :
   - air locale indisponible => arrêt actionneurs + défaut
   - plaque trop froide => froid interdit jusqu'à reprise
4. Décision de mode :
   - humidité externe valide => mode thermo + déshumidification par froid
   - humidité invalide/périmée => mode température seule
5. Application des commandes avec inter-verrouillage strict froid/chauffage.

## Modes

### Mode normal

- Température pilotée avec hystérésis.
- Déshumidification possible uniquement si humidité externe valide et au-dessus du seuil.

### Mode fallback

- Température externe invalide/périmée => utilisation de la température air locale.
- Humidité externe invalide/périmée => désactivation de la déshumidification pilotée.
- Sonde air locale absente => arrêt sécurisé.

## Déploiement sur Shelly

1. Copier le contenu de `src/cave_saucisson.js`.
2. Ouvrir l'interface Shelly > Scripts > Nouveau script.
3. Coller le script et sauvegarder.
4. Ajuster la section `CONFIG` si nécessaire (IDs sondes/relais, topics).
5. Activer MQTT côté Shelly si utilisé.
6. Démarrer le script et surveiller les topics `state`/`fault`.

## Configuration

Toute la configuration est regroupée en tête de script dans un objet `CONFIG`.

Paramètres principaux :

- consignes et hystérésis température (`coolOnC`, `coolOffC`, `heatOnC`, `heatOffC`)
- sécurité plaque (`plateMinOffC`, `plateMinResumeC`)
- fraîcheur MQTT (`tempStaleS`, `humidityStaleS`)
- verrou anti-cycles compresseur (`lockoutS`)
- adaptation durée max de cycle froid (`adaptiveCoolMax*`)

## Sécurité

- Le script privilégie toujours la sécurité thermique aux performances.
- Le chauffage n'est jamais utilisé pour contrôler directement l'humidité.
- Les sorties sont forcées à OFF en cas de défaut critique capteur air.
- **Ce script ne remplace pas des sécurités matérielles** (thermostat physique, protections électriques, etc.).

## Limites connues

- L'humidité est pilotée via une sonde externe MQTT uniquement.
- Pas de régulation PID : logique volontairement simple (hystérésis + garde-fous).
- Qualité de régulation dépend de la qualité de placement/calibration des sondes.

## Roadmap minimale

- Ajouter un guide de calibration avancée par saison.
- Ajouter un profil de paramètres « hiver/été » documenté.
- Ajouter un export d'événements simplifié pour audit de cycles.
