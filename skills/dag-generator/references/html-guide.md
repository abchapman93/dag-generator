# HTML DAG Generation Guide

## Structure

Every HTML DAG file is a single self-contained `.html` file with embedded CSS and inline SVG. No external dependencies.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>[DAG Title]</title>
  <style>/* embedded styles */</style>
</head>
<body>
  <div class="header">
    <h1>[Title]</h1>
    <p class="subtitle">[One-line description of what the DAG shows]</p>
  </div>
  <div class="dag-container">
    <svg viewBox="0 0 [width] [height]">
      <!-- Arrow markers -->
      <!-- Time labels (if longitudinal) -->
      <!-- Nodes -->
      <!-- Edges -->
      <!-- Path highlights -->
      <!-- Annotations within SVG -->
    </svg>
  </div>
  <div class="legend">
    <!-- Node type legend -->
    <!-- Key path explanations -->
    <!-- Context-specific notes -->
  </div>
</body>
</html>
```

## Base CSS

```css
body {
  font-family: 'Segoe UI', system-ui, sans-serif;
  background: #fafafa;
  margin: 0;
  padding: 24px;
  color: #1a1a1a;
}
h1 { font-size: 1.3em; margin-bottom: 4px; }
.subtitle { color: #555; font-size: 0.95em; margin-bottom: 20px; }
.dag-container {
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 24px;
  max-width: 900px;
  margin: 0 auto 24px auto;
}
svg text { font-family: 'Segoe UI', system-ui, sans-serif; }
.legend {
  font-size: 0.85em;
  color: #444;
  max-width: 900px;
  margin: 0 auto;
  line-height: 1.6;
}
.legend p { margin: 6px 0; }
.legend-color {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  vertical-align: middle;
  margin-right: 4px;
}
```

## SVG Components

### Arrow markers

Define one marker per color used for edges:

```xml
<defs>
  <marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
    <path d="M0,0 L8,3 L0,6 Z" fill="#555"/>
  </marker>
  <marker id="arrow-red" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
    <path d="M0,0 L8,3 L0,6 Z" fill="#c0392b"/>
  </marker>
  <marker id="arrow-blue" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
    <path d="M0,0 L8,3 L0,6 Z" fill="#2471a3"/>
  </marker>
</defs>
```

### Nodes

Rectangular nodes with rounded corners. Size varies by label length.

```xml
<!-- Standard node -->
<rect x="30" y="50" width="100" height="40" rx="6" fill="#d5e8d4" stroke="#82b366" stroke-width="1.5"/>
<text x="80" y="75" text-anchor="middle" font-size="13" font-weight="600">L₃ (state)</text>

<!-- Conditioned-on node (double border) -->
<rect x="570" y="260" width="160" height="50" rx="6" fill="#f8d7da" stroke="#c0392b" stroke-width="2.5"/>
<rect x="573" y="263" width="154" height="44" rx="4" fill="none" stroke="#c0392b" stroke-width="1" stroke-dasharray="4,2"/>
<text x="650" y="290" text-anchor="middle" font-size="13" font-weight="700" fill="#922">U = 1</text>

<!-- Unmeasured/latent node -->
<rect x="200" y="150" width="80" height="40" rx="6" fill="#f0f0f0" stroke="#999" stroke-width="1.5" stroke-dasharray="5,3"/>
<text x="240" y="175" text-anchor="middle" font-size="13" font-style="italic" fill="#666">U</text>
```

### Edges

```xml
<!-- Straight causal arrow -->
<line x1="130" y1="70" x2="198" y2="70" stroke="#555" stroke-width="1.3" marker-end="url(#arrow)"/>

<!-- Curved arrow (for crossing paths or non-adjacent nodes) -->
<path d="M130,160 Q165,120 200,70" fill="none" stroke="#555" stroke-width="1.3" marker-end="url(#arrow)"/>

<!-- Long curved arrow (spanning multiple time points) -->
<path d="M130,60 Q400,20 680,60" fill="none" stroke="#2471a3" stroke-width="1.8" marker-end="url(#arrow-blue)"/>

<!-- Highlighted biasing path -->
<path d="M80,190 Q80,250 575,275" fill="none" stroke="#c0392b" stroke-width="1.5" marker-end="url(#arrow-red)"/>

<!-- Bidirected arc (unmeasured common cause) -->
<path d="M130,60 Q200,20 270,60" fill="none" stroke="#999" stroke-width="1.3" stroke-dasharray="5,3"
      marker-start="url(#arrow-gray)" marker-end="url(#arrow-gray)"/>
```

### Time labels (longitudinal DAGs)

```xml
<text x="80" y="28" font-size="11" fill="#888" text-anchor="middle">day 3</text>
<text x="250" y="28" font-size="11" fill="#888" text-anchor="middle">day 4</text>
```

### Highlighted path summary box

Place at the bottom of the SVG to call out the key spurious or causal path:

```xml
<rect x="20" y="360" width="780" height="48" rx="6" fill="#fef3f3" stroke="#e6a0a0" stroke-width="1"/>
<text x="410" y="382" text-anchor="middle" font-size="12" fill="#922">
  Spurious path opened by conditioning:
</text>
<text x="410" y="400" text-anchor="middle" font-size="13" font-weight="600" fill="#922">
  L₃  →  A₃  →  U  ←  A₄  ←  L₄  →  Y
</text>
```

## Layout Guidelines

### Sizing
- **viewBox width:** 700–900 for most DAGs. Use 500–600 for simple 3-4 node DAGs.
- **viewBox height:** Scale with number of rows. Typically 300–450.
- **Node spacing:** At least 150px horizontal between time points, 80–100px vertical between rows.
- **Padding:** 20–30px from SVG edges.

### Row structure for longitudinal DAGs
- **Row 1 (top):** Covariates $L_t$
- **Row 2 (middle):** Treatment $A_t$
- **Row 3 (bottom):** Selection/conditioning variables, or outcome if single time point
- **Outcome:** Far right, vertically centered or in its own position

### Curved edges
Use quadratic Bézier paths (`Q`) for edges that need to cross or span long distances. The control point should create a gentle arc — avoid sharp bends. For edges going from Row 2 up to Row 1 at the next time point (treatment → future covariate), curve upward.

## Legend Section

Always include a legend below the SVG. Structure:

```html
<div class="legend">
  <p><strong>Reading the DAG:</strong></p>
  <p><span class="legend-color" style="background:#d5e8d4;border:1px solid #82b366;"></span>
     <strong>Green nodes:</strong> [description]</p>
  <!-- ... one entry per node type used ... -->
  <p style="margin-top:12px;"><strong>The bias mechanism:</strong></p>
  <p>[Explanation of the key path or structural feature]</p>
</div>
```

Keep the legend concise but informative. It should explain not just what the colors mean but *why the DAG structure matters* — what path is opened/blocked, what bias is created, what the weights correct for.
