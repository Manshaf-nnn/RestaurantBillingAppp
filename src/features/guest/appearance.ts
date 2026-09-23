/**
 * How guests are met (ar.md §10, §13, §19).
 *
 * ── One setting, every code ─────────────────────────────────────────────────
 *
 * A guest scanning the card on table 6 and a guest scanning the takeaway
 * poster in the window should meet the same restaurant. So this is a single
 * restaurant-level setting that BOTH the ordinary `/order` flow and every QR
 * menu read. A QR menu's own switches narrow it for that one code; they never
 * fork it into a second look that then drifts.
 *
 * ── Settings, not constants ─────────────────────────────────────────────────
 *
 * Every field here was a hard-coded string or a `true` in a component. Pulling
 * them into one object with documented defaults means an owner can change the
 * words their guests read without a deploy, and — just as important — that a
 * field added later still yields a complete object when merged over a row
 * written before it existed. That is why reads merge over `DEFAULT_APPEARANCE`
 * rather than trusting the stored Json to be whole.
 *
 * Pure: no database, no `server-only`, so the settings editor, the live
 * preview and the guest screens all read the same shape.
 */

export type MenuLayout = 'LIST' | 'GRID'

export interface GuestAppearance {
  /* ── The welcome screen ───────────────────────────────────────────────── */
  /** The logo badge above the restaurant's name. */
  showLogo: boolean
  /** The one-line tagline under it. */
  showTagline: boolean
  /** The opening-hours pill with its Open / Closed dot. */
  showHours: boolean
  /** The "Powered by TableFlow" block inside the card. */
  showPoweredBy: boolean
  /** The four Scan / Order / Track / Pay tiles. */
  showTiles: boolean
  /** The copyright line at the very bottom. */
  showFooter: boolean

  /**
   * What the card asks. Blank falls back to the built-in wording rather than
   * showing a guest an empty heading.
   */
  headingText: string
  helperText: string
  buttonText: string
  /** The small line under the tiles. */
  footerNote: string

  /**
   * The heading and helper for a code with no table (`askTable: false`) —
   * a delivery leaflet or a takeaway counter, where "what is your table
   * number?" is a question with no answer.
   */
  noTableHeadingText: string
  noTableHelperText: string

  /* ── The menu ─────────────────────────────────────────────────────────── */
  menuShowSearch: boolean
  menuShowPrices: boolean
  menuShowImages: boolean
  menuShowDescriptions: boolean
  /** The "Chef's picks & favourites" rail above the sections. */
  menuShowFeatured: boolean
  /**
   * `LIST` is a row per dish with the image on the right — dense, and what
   * this app has always shown. `GRID` is two cards across, which reads better
   * for a short menu with good photography and worse for a long one.
   */
  menuLayout: MenuLayout

  /* ── The look ─────────────────────────────────────────────────────────── */
  /**
   * `AUTO` samples the accent from the restaurant's own logo, which is what
   * the guest screens have always done. A hex value pins it, for an owner
   * whose logo is black-and-white or who simply wants a different colour.
   */
  accentMode: 'AUTO' | 'CUSTOM'
  /** `#rrggbb`, honoured only when `accentMode` is CUSTOM. */
  accentColour: string
}

/**
 * Exactly what the guest screens showed before any of this was configurable.
 *
 * Changing a value here changes it for every restaurant that has never opened
 * the settings page, so these are the shipped product, not placeholders.
 */
export const DEFAULT_APPEARANCE: GuestAppearance = {
  showLogo: true,
  showTagline: true,
  showHours: true,
  showPoweredBy: true,
  showTiles: true,
  showFooter: true,

  headingText: 'What is your table number?',
  helperText: 'You will find it on the stand or card on your table.',
  buttonText: 'Continue to the menu',
  footerNote: 'No app, no sign-up. Order straight from your phone.',

  noTableHeadingText: 'Welcome',
  noTableHelperText: 'Browse the menu and order straight from your phone.',

  menuShowSearch: true,
  menuShowPrices: true,
  menuShowImages: true,
  menuShowDescriptions: true,
  menuShowFeatured: true,
  menuLayout: 'LIST',

  accentMode: 'AUTO',
  accentColour: '#f97316',
}

const HEX = /^#[0-9a-f]{6}$/i

/**
 * A stored value merged over the defaults.
 *
 * Deliberately field by field rather than a spread: the column is Json and has
 * been written by older versions of this code, so a key holding the wrong type
 * — a string where a boolean belongs — must fall back to the default rather
 * than reach a component that will render it.
 */
export function readAppearance(stored: unknown): GuestAppearance {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { ...DEFAULT_APPEARANCE }
  const raw = stored as Record<string, unknown>

  const flag = (key: keyof GuestAppearance): boolean =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : (DEFAULT_APPEARANCE[key] as boolean)

  const text = (key: keyof GuestAppearance): string => {
    const value = raw[key]
    // Blank is not a choice — it would leave a guest reading nothing.
    return typeof value === 'string' && value.trim() ? value.trim() : (DEFAULT_APPEARANCE[key] as string)
  }

  return {
    showLogo: flag('showLogo'),
    showTagline: flag('showTagline'),
    showHours: flag('showHours'),
    showPoweredBy: flag('showPoweredBy'),
    showTiles: flag('showTiles'),
    showFooter: flag('showFooter'),

    headingText: text('headingText'),
    helperText: text('helperText'),
    buttonText: text('buttonText'),
    footerNote: text('footerNote'),
    noTableHeadingText: text('noTableHeadingText'),
    noTableHelperText: text('noTableHelperText'),

    menuShowSearch: flag('menuShowSearch'),
    menuShowPrices: flag('menuShowPrices'),
    menuShowImages: flag('menuShowImages'),
    menuShowDescriptions: flag('menuShowDescriptions'),
    menuShowFeatured: flag('menuShowFeatured'),
    menuLayout: raw.menuLayout === 'GRID' ? 'GRID' : 'LIST',

    accentMode: raw.accentMode === 'CUSTOM' ? 'CUSTOM' : 'AUTO',
    accentColour: typeof raw.accentColour === 'string' && HEX.test(raw.accentColour)
      ? raw.accentColour
      : DEFAULT_APPEARANCE.accentColour,
  }
}

/** `#f97316` → `249 115 22`, for the CSS custom properties the guest screens use. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!HEX.test(hex)) return null
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  }
}

/**
 * What one QR menu actually shows, once its own switches have narrowed the
 * restaurant's setting.
 *
 * Narrowing only, never widening: a code cannot turn ON something the
 * restaurant has turned off. That is what keeps "one setting, every code"
 * true — the QR editor's switches are a subtraction, so an owner who hides
 * prices everywhere does not have to remember to hide them again per code.
 */
export function narrowAppearance(
  appearance: GuestAppearance,
  code: {
    showSearch?: boolean
    showPrices?: boolean
    askTable?: boolean
  } | null,
): GuestAppearance {
  if (!code) return appearance
  return {
    ...appearance,
    menuShowSearch: appearance.menuShowSearch && code.showSearch !== false,
    menuShowPrices: appearance.menuShowPrices && code.showPrices !== false,
  }
}
