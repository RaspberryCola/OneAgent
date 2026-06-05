# OneAgent Typography Reference

## Font Families

| Role | Font Stack |
|------|------------|
| Display | `SF Pro Rounded`, `system-ui, -apple-system, system-ui` |
| Body/UI | `ui-sans-serif`, `system-ui, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji` |
| Monospace | `ui-monospace`, `SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New` |

*Note: SF Pro Rounded renders with rounded terminals on macOS/iOS, falls back to system sans-serif on other platforms.*

## Type Scale

| Role | Font | Size | Weight | Line Height | Notes |
|------|------|------|--------|-------------|-------|
| Display/Hero | SF Pro Rounded | 48px (3rem) | 500 | 1.00 | Maximum impact |
| Section Heading | SF Pro Rounded | 36px (2.25rem) | 500 | 1.11 | Feature titles |
| Sub-heading | SF Pro Rounded | 30px (1.88rem) | 400–500 | 1.20 | Card headings |
| Card Title | ui-sans-serif | 24px (1.5rem) | 400 | 1.33 | Medium emphasis |
| Body Large | ui-sans-serif | 18px (1.13rem) | 400–500 | 1.56 | Hero descriptions |
| Body/Link | ui-sans-serif | 16px (1rem) | 400–500 | 1.50 | Standard text |
| Caption | ui-sans-serif | 14px (0.88rem) | 400 | 1.43 | Metadata |
| Small | ui-sans-serif | 12px (0.75rem) | 400 | 1.33 | Smallest text |
| Code Body | ui-monospace | 16px (1rem) | 400 | 1.50 | Inline code |
| Code Caption | ui-monospace | 14px (0.88rem) | 400 | 1.43 | Code snippets |
| Code Small | ui-monospace | 12px (0.75rem) | 400–700 | 1.63 | Tags, labels |

## Typography Principles

1. **Rounded display, standard body**: SF Pro Rounded for headlines, system sans for body
2. **Weight restraint**: Only 400 (regular) and 500 (medium) — no bold, no light, no black
3. **Tight display, comfortable body**: Headlines at 1.0 line-height, body at 1.43–1.56
4. **Monospace for code**: Terminal commands and code are primary content

## Tailwind Classes

```css
/* Font Families */
font-['SF_Pro_Rounded']  /* Display */
font-sans                /* Body */
font-mono                /* Code */

/* Font Weights */
font-normal  /* 400 */
font-medium  /* 500 */

/* Font Sizes */
text-xs    /* 12px */
text-sm    /* 14px */
text-base  /* 16px */
text-lg    /* 18px */
text-xl    /* 20px */
text-2xl   /* 24px */
text-3xl   /* 30px */
text-4xl   /* 36px */
text-5xl   /* 48px */

/* Line Heights */
leading-none    /* 1.0 */
leading-tight   /* 1.25 */
leading-snug    /* 1.375 */
leading-normal  /* 1.5 */
leading-relaxed /* 1.625 */
```

## Responsive Typography

| Breakpoint | Hero Size | Section Heading |
|------------|-----------|-----------------|
| Mobile | 30px | 24px |
| Tablet | 36px | 30px |
| Desktop | 48px | 36px |
