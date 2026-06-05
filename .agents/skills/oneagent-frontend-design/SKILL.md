---
name: oneagent-frontend-design
description: Apply OneAgent's Ollama-inspired minimalist design system when creating or modifying frontend components. Use when building UI elements, styling components, or reviewing frontend code in the OneAgent project. Enforces strict grayscale palette, specific border-radius rules, SF Pro Rounded typography, and zero-shadow philosophy.
---

# OneAgent Frontend Design System

OneAgent uses an Ollama-inspired design system: radical minimalism with pure grayscale, rounded geometry, and zero shadows.

## Core Principles

1. **Pure Grayscale** — No chromatic colors except blue focus ring (`#3b82f6` at 50%)
2. **Zero Shadows** — Depth from borders and background shifts only
3. **Rounded Geometry** — Three-tier radius: 12px (containers), 8px (interactive), 9999px (pill, special cases only)
4. **Weight Restraint** — Only 400 (body) and 500 (headings), never bold

## Quick Color Reference

| Role | Color | Hex |
|------|-------|-----|
| Primary Text | Pure Black | `#000000` |
| Page Background | Pure White | `#ffffff` |
| Secondary Text | Stone | `#737373` |
| Button Background | Light Gray | `#e5e5e5` |
| Borders | Light Gray | `#e5e5e5` |
| Muted Text | Silver | `#a3a3a3` |
| Dark Text | Near Black | `#262626` |
| Subtle Surface | Snow | `#fafafa` |
| Focus Ring | Ring Blue | `#3b82f6` (50%) |

## Typography Rules

- **Display/Headlines**: `SF Pro Rounded`, weight 500
- **Body/UI**: `ui-sans-serif`, weight 400
- **Code**: `ui-monospace`, weight 400
- **Line Heights**: 1.0 (headings), 1.43–1.56 (body)

## Component Styling

### Buttons
All buttons: `padding: 10px 24px`, `border-radius: 8px`

| Type | Background | Text | Border |
|------|------------|------|--------|
| Primary (Gray) | `#e5e5e5` | `#262626` | `1px solid #e5e5e5` |
| Secondary (White) | `#ffffff` | `#404040` | `1px solid #d4d4d4` |
| CTA (Black) | `#000000` | `#ffffff` | none |

### Cards & Containers
- Background: `#ffffff` or `#fafafa`
- Border: `1px solid #e5e5e5` when needed
- Radius: `12px`
- Shadow: **none**

### Inputs & Forms
- Background: `#ffffff`
- Border: `1px solid #e5e5e5`
- Radius: `8px`
- Focus: `#3b82f6` ring
- Placeholder: `#a3a3a3`

### Tabs
- Radius: `8px`
- Active: `#e5e5e5` background, `#262626` text
- Inactive: transparent, `#737373` text

### Tags
- Radius: `8px`
- Background: `#e5e5e5`
- Text: dark

## Layout Rules

- **Spacing base**: 8px
- **Button padding**: 10px 24px (all buttons)
- **Card padding**: 24–32px
- **Section spacing**: 88–112px
- **Max width**: 1024–1280px centered

## Do's and Don'ts

### Do
- Use pure white (`#ffffff`) background
- Use 8px radius on interactive elements
- Use 12px radius on containers
- Keep palette strictly grayscale
- Use SF Pro Rounded at weight 500 for headlines
- Maintain zero shadows
- Use monospace for code/terminal

### Don't
- Introduce chromatic colors
- Use radius other than 12px/8px/9999px
- Add shadows
- Use font weights above 500
- Use gradients
- Add decorative illustrations
- Use borders heavier than 1px
- Add hover animations

## Reference Files

- For detailed color palette: [COLOR_REFERENCE.md](COLOR_REFERENCE.md)
- For typography details: [TYPOGRAPHY_REFERENCE.md](TYPOGRAPHY_REFERENCE.md)
- For component specifics: [COMPONENT_REFERENCE.md](COMPONENT_REFERENCE.md)

## Responsive Breakpoints

| Name | Width | Changes |
|------|-------|---------|
| Mobile | <640px | Single column, hamburger nav |
| Tablet | 768–850px | 2-column begins |
| Desktop | 850–1024px | Standard layout |
| Large | 1024–1280px | Max width |

## Example Prompts

- "Create a button with `bg-[#e5e5e5] text-[#262626] rounded-[8px] px-6 py-2.5`"
- "Style a card with `bg-white border border-[#e5e5e5] rounded-[12px] p-6 shadow-none`"
- "Add a focus ring with `focus:ring-2 focus:ring-[#3b82f6]/50`"
