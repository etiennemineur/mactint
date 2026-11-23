# MacTint

*Read in English : [README.md](README.md)*

Un logiciel de dessin bitmap en seize couleurs où chaque geste joue une note. MacTint part
de MacPaint (1984) et l’emmène ailleurs : la couleur, la trame, le mouvement et le son.

**À essayer en ligne : <https://etienne.design/tools/mactint/>**

![MacTint : six volumes de couleur, un grand trait arc-en-ciel et un trait hérissé de pics](preview.png)

## Ce qu’il fait

- **Les vingt outils classiques** de MacPaint, avec les 38 trames d’origine, dans les seize
  couleurs du Macintosh II, plus vos propres couleurs.
- **Une soixantaine d’outils en plus**, en cinq familles : *Draw* (pinceau vivant, pinceau
  barbelé, ligne molle, ruban de papier…), *Effects* (acide, glitch, pinceau fondant,
  dynamite…), *Life* (chenille, sphères volantes, envol…), *Cycle* (couleurs qui tournent) et
  *3D* (six volumes dessinés par lancer de rayons, ombrés en trame).
- **Une seule épaisseur pour tout**, de 1 à 200 points : chaque outil la suit.
- **Des dégradés** : en trame de points ou en lignes entre deux couleurs, et quatre modes
  arc-en-ciel.
- **Des calques**, des pages jusqu’à 2 048 points, l’export en PNG et en GIF animé.
- **Le son** : chaque outil a sa voix, son rythme et sa batterie, fabriqués en direct. La
  musique ne vient que de vous. Sans geste, le silence.
- **La barre d’espace** : tout ce qui bouge se fige exactement comme vous le voyez.

## Le lancer chez soi

Aucune étape de fabrication, aucune dépendance. Il suffit de servir le dossier avec
n’importe quel serveur web statique :

```bash
python3 -m http.server 8000
```

Puis d’ouvrir <http://localhost:8000/>.

## Les fichiers

| Fichier | Contenu |
|---|---|
| `index.html` | La page : un canvas et trois scripts. |
| `colorpaint.js` | Toute l’application : interface, outils, effets, export. |
| `studio.js` | Le moteur sonore (Web Audio, aucun fichier son). |
| `classic-data.js` | Les données d’origine de MacPaint et du Macintosh. **Hors licence MIT**, voir plus bas. |
| `preview.png` | L’image d’aperçu, dessinée dans MacTint. |

Le script s’appelle encore `colorpaint.js` : MacTint s’est d’abord appelé ColorPaint.

## Licence

Le code est publié sous [licence MIT](LICENSE).

`classic-data.js` contient des polices et des ressources issues de logiciels d’origine
d’Apple. Elles restent la propriété d’Apple Inc. et ne sont **pas** couvertes par la licence
MIT : lisez [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) avant de réutiliser ce projet.

MacTint est un hommage non officiel, sans lien avec Apple.

Designé et imaginé par Étienne Mineur, novembre 2026.
