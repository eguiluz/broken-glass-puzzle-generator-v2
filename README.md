# Cristal/Roto

Generador web de puzzles con efecto **cristal roto**, listos para **corte láser**.

- Clic (o arrastrar) sobre la plancha para colocar el punto de impacto.
- Sliders para número de piezas, ancho, alto, concentración de piezas en el impacto y tamaño de pestaña.
- Pestañas de encaje tipo cola de milano, flecha o mezcla, con comprobación de colisiones.
- Texto personalizado (por ejemplo, un nombre): cada letra es una pieza con su forma exacta, las grietas
  se detienen en ella y los huecos de letras como la D o la A son piezas propias.
- Exporta un SVG en milímetros, líneas negras sin relleno. Cada grieta compartida se exporta **una sola vez**
  (sin cortes dobles) y las líneas se encadenan para reducir los saltos del cabezal.
- La configuración queda en la URL: se puede compartir y reproducir exactamente (semilla incluida).

## Desarrollo

```sh
npm install
npm run dev
```

Tests (reproducibilidad de enlaces antiguos, sin cortes dobles, contornos válidos, texto y zonas frágiles):

```sh
npm test
```

## Despliegue en GitHub Pages

Se despliega automáticamente al crear un tag (`.github/workflows/deploy.yml`):

```sh
git tag v1.0.0
git push origin v1.0.0
```

También se puede lanzar a mano desde la pestaña **Actions** (*Run workflow*).

## Cómo funciona

`src/lib/shatter.ts`: semillas en una red polar alrededor del impacto (el espaciado crece con la distancia
y los rayos se bifurcan como grietas reales) → diagrama de Voronoi recortado a la plancha (`d3-delaunay`)
→ fusión de aristas muy cortas → pestañas en las aristas interiores, verificando holgura con el resto de la pieza.
