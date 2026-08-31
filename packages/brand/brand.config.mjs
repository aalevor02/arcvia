/**
 * Single source of truth for brand identity.
 *
 * Everything user-visible — the Astro site, the Studio editor chrome, the
 * published walkthrough shell, and the plan viewer export — reads from here.
 * Rebranding the whole product is an edit to this one file.
 */

export const brand = {
  // ---- Identity -----------------------------------------------------------
  name: 'Arcvia',
  legalName: 'Arcvia Technologies Pvt Ltd',
  tagline: 'AI powered visualisation tools for real estate',
  description:
    'The fastest way to turn architectural drawings into interactive, ' +
    'configurable 3D walkthroughs your clients can explore on any device.',

  // ---- Domains ------------------------------------------------------------
  // Mirrors the reference architecture: marketing / studio / published output
  // are three separate origins so each can be cached and scaled differently.
  domains: {
    marketing: 'https://arcvia.example',
    studio: 'https://studio.arcvia.example',
    walkthrough: 'https://view.arcvia.example',
    planViewer: 'https://plan.arcvia.example',
  },

  // ---- Colour ------------------------------------------------------------
  // Deliberately a *different* palette from the reference site: a cool
  // architectural blue rather than the yellow/near-black pairing, so the two
  // products are not mistaken for each other.
  color: {
    ink: '#12161d', // near-black, primary text and dark surfaces
    inkSoft: '#5b6472', // secondary text
    line: '#e3e7ed', // hairline borders
    surface: '#ffffff',
    surfaceAlt: '#f6f8fb',

    accent: '#2f6df6', // primary action
    accentHover: '#2357cc',
    accentSoft: '#e8f0ff', // tinted fill behind accent content

    // ---- Accent as TEXT, which is a different problem from accent as a fill
    //
    // `accent` measures 4.53:1 on white — over the 4.5:1 WCAG AA needs for
    // normal text, and only just. That margin is gone the moment the text sits
    // on anything tinted, and the site tints constantly. Measured in the
    // browser on the built homepage, the `.eyebrow` label (12px, 600) came out:
    //
    //     on surfaceAlt #f6f8fb   4.25:1   FAIL
    //     on ink        #12161d   4.01:1   FAIL
    //     on accentSoft #e8f0ff   3.95:1   FAIL
    //
    // Three of the four backgrounds it is actually used on. A fill does not
    // have this problem, which is why one accent was enough until now.
    //
    // No single value fixes it: the light backgrounds need a DARKER blue and
    // the dark panel needs a LIGHTER one — pushing `accent` down to pass on
    // surfaceAlt takes it to 2.85:1 on ink, which is worse than where it
    // started. So there are two, and which one applies is a property of the
    // background rather than of the text.
    accentInk: '#2357cc', // accent text on white / surfaceAlt / accentSoft — 5.5-6.0:1
    accentOnDark: '#8ab4ff', // accent text on ink — 8.7:1

    signal: '#00c2a8', // success / "render complete"
    warn: '#f5a524',
    danger: '#e5484d',
  },

  // ---- Type ---------------------------------------------------------------
  // Self-hosted rather than pulled from a third-party CDN at runtime: one less
  // external dependency on the critical render path, and no layout shift.
  font: {
    sans: '"Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },

  // ---- Social / tracking --------------------------------------------------
  // Left empty on purpose. Analytics IDs are injected from env at build time so
  // that a fork of this repo never silently reports into someone else's account.
  social: {
    linkedin: '',
    instagram: '',
  },
}

export default brand
