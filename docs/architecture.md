# Architecture logique

## Vue d'ensemble

Le système repose sur un script Shelly unique qui :

1. lit des capteurs locaux (air + plaque)
2. lit des mesures externes MQTT (température + humidité) si disponibles
3. décide d'un mode de régulation sûr
4. commande deux relais (froid/chauffage) avec inter-verrouillage strict
5. publie un état synthétique et des défauts

## Entrées / sorties

### Entrées

- `temperature:100` : température d'air locale (obligatoire)
- `temperature:101` : température plaque froide (sécurité froid)
- MQTT température externe (optionnel)
- MQTT humidité externe (optionnel)

### Sorties

- `switch:0` : compresseur
- `switch:1` : chauffage
- MQTT : état, mode, défauts, fraîcheur capteurs

## Logique de régulation

### Température

- Refroidissement par hystérésis :
  - ON si T >= `coolOnC`
  - OFF si T <= `coolOffC`
- Chauffage de protection basse température :
  - ON si T <= `heatOnC`
  - OFF si T >= `heatOffC`
  - inhibé si T >= `heatDisableAboveC`

### Humidité

- Déshumidification uniquement via condensation sur plaque froide.
- Active seulement si humidité externe valide :
  - ON si RH >= `rhOn`
  - OFF si RH <= `rhOff`
- Si humidité invalide/périmée : mode température seule.

### Sécurité plaque froide

- Si plaque <= `plateMinOffC` : arrêt immédiat du froid.
- Reprise possible seulement si plaque >= `plateMinResumeC`.

### Anti-cycles compresseur

- `lockoutS` impose un délai mini entre deux démarrages froid.
- Limite durée de cycle froid adaptative (`adaptiveCoolMax*`).

## Priorités de sécurité

Ordre de priorité :

1. Défaut critique capteur air local => tout OFF
2. Interdiction simultané chauffage/froid
3. Protection plaque froide / anti-gel
4. Respect plafond ambiance (`hardMaxAirC`)
5. Régulation hygrométrique si données valides

## Modes dégradés

- Température externe absente/périmée -> fallback sur air local.
- Humidité externe absente/périmée -> désactivation déshumidification.
- Capteur plaque absent -> froid interdit (chauffage possible selon sécurité air).

## Philosophie KISS

- Hystérésis explicite plutôt qu'algorithmes complexes.
- Paramètres regroupés et lisibles.
- Télémétrie concise pour exploitation terrain.
- Zéro dépendance runtime externe.
