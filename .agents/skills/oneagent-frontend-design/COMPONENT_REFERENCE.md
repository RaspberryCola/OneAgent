# OneAgent Component Reference

## Buttons

### Gray Button (Primary)
```css
background: #e5e5e5;
color: #262626;
padding: 10px 24px;
border: 1px solid #e5e5e5;
border-radius: 8px;
```

### White Button (Secondary)
```css
background: #ffffff;
color: #404040;
padding: 10px 24px;
border: 1px solid #d4d4d4;
border-radius: 8px;
```

### Black Button (CTA)
```css
background: #000000;
color: #ffffff;
padding: 10px 24px;
border-radius: 8px;
```

### Button Rules
- All buttons: `padding: 10px 24px`, `border-radius: 8px`
- No shadows on any button
- No hover animations
- Consistent sizing across all buttons

## Cards & Containers

```css
background: #ffffff or #fafafa;
border: 1px solid #e5e5e5;  /* when needed */
border-radius: 12px;
padding: 24-32px;
box-shadow: none;
```

### Container Rules
- Radius: 12px (never 8px for containers)
- No shadows
- Border only when needed for containment
- Hover: subtle background shift or border darkening

## Inputs & Forms

```css
background: #ffffff;
border: 1px solid #e5e5e5;
border-radius: 8px;
placeholder-color: #a3a3a3;
```

### Focus State
```css
outline: none;
ring: 2px solid #3b82f6 at 50% opacity;
```

## Tabs

```css
/* Active Tab */
background: #e5e5e5;
color: #262626;
border-radius: 8px;

/* Inactive Tab */
background: transparent;
color: #737373;
border-radius: 8px;
```

## Tags

```css
background: #e5e5e5;
color: dark;
border-radius: 8px;
padding: small;
```

## Navigation

```css
background: transparent;
border: none;
/* Logo: black */
/* Links: Pure Black, 16px, weight 400 */
/* Search: 8px rounded */
/* CTA: black 8px rounded button */
```

## Terminal Command Block

```css
background: #ffffff;
border: 1px solid #e5e5e5;
border-radius: 12px;
font-family: ui-monospace;
font-size: 16px;
```

## Integration Grid

- Grid of integration logos
- Each in bordered card (8px radius) or 12px-radius card
- Icon + name inside
- 4 columns on desktop, responsive down

## Border Radius Scale

| Radius | Usage |
|--------|-------|
| 12px | Containers — code blocks, cards, panels |
| 8px | Interactive — buttons, tabs, inputs, tags, badges |
| 9999px | Special — Homepage Agent switcher, Toggle switches only |

## Spacing Scale

```
4px, 6px, 8px, 9px, 10px, 12px, 14px, 16px, 20px, 24px, 32px, 40px, 48px, 88px, 112px
```

Base unit: 8px

## Responsive Behavior

| Component | Mobile | Tablet | Desktop |
|-----------|--------|--------|---------|
| Navigation | Hamburger menu | Horizontal | Horizontal |
| Hero text | 30px | 36px | 48px |
| Feature sections | Stacked | 2-column | 2-column |
| Integration grid | 1-col | 2-col | 4-col |
| Code blocks | Horizontal scroll | Horizontal scroll | Horizontal scroll |
