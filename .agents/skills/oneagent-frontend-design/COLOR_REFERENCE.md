# OneAgent Color Reference

## Color Palette

### Primary Colors

| Name | Hex | Usage |
|------|-----|-------|
| Pure Black | `#000000` | Primary headlines, primary links, darkest text |
| Near Black | `#262626` | Button text on light surfaces, secondary headlines |
| Darkest Surface | `#090909` | Footer, dark containers |

### Surface & Background

| Name | Hex | Usage |
|------|-----|-------|
| Pure White | `#ffffff` | Page background, button surfaces for secondary actions |
| Snow | `#fafafa` | Section backgrounds, barely-elevated containers |
| Light Gray | `#e5e5e5` | Button backgrounds, borders, primary containment |

### Neutrals & Text

| Name | Hex | Usage |
|------|-----|-------|
| Stone | `#737373` | Secondary body text, footer links, de-emphasized content |
| Mid Gray | `#525252` | Emphasized secondary text |
| Silver | `#a3a3a3` | Tertiary text, placeholders, deeply de-emphasized metadata |
| Button Text Dark | `#404040` | White-surface button text |

### Semantic & Accent

| Name | Hex | Usage |
|------|-----|-------|
| Ring Blue | `#3b82f6` (50%) | Focus ring only — NEVER visible in normal flow |
| Border Light | `#d4d4d4` | White-surface button borders |

## Grayscale Scale

```
#000000  Pure Black
#090909  Darkest Surface
#262626  Near Black
#404040  Button Text Dark
#525252  Mid Gray
#737373  Stone
#a3a3a3  Silver
#d4d4d4  Border Light
#e5e5e5  Light Gray
#fafafa  Snow
#ffffff  Pure White
```

## Color Usage Rules

1. **Background**: Always pure white (`#ffffff`), never off-white or cream
2. **Text**: Pure black (`#000000`) for primary, Stone (`#737373`) for secondary
3. **Borders**: Light Gray (`#e5e5e5`) for most borders
4. **Buttons**: Light Gray background with Near Black text
5. **Focus**: Ring Blue (`#3b82f6`) at 50% opacity only
6. **No gradients**: Zero gradients anywhere
7. **No chromatic colors**: Only grayscale except focus ring

## Tailwind Classes

```css
/* Backgrounds */
bg-white      /* #ffffff */
bg-[#fafafa]  /* Snow */
bg-[#e5e5e5]  /* Light Gray */
bg-[#000000]  /* Pure Black */

/* Text */
text-black    /* #000000 */
text-[#262626] /* Near Black */
text-[#737373] /* Stone */
text-[#a3a3a3] /* Silver */

/* Borders */
border-[#e5e5e5]  /* Light Gray */
border-[#d4d4d4]  /* Border Light */

/* Focus */
focus:ring-[#3b82f6]/50  /* Ring Blue at 50% */
```
