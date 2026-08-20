export interface Faq {
  q: string
  a: string
}

export const faqs: Faq[] = [
  {
    q: 'What is this, and how does it work?',
    a: 'A real-time visualisation tool that turns an architectural drawing into an interactive 3D walkthrough. Upload a 2D floor plan or an existing 3D model — CAD, SketchUp, PDF, JPG or PNG all work — customise the materials, furniture and lighting, then share a link. Anyone with the link can explore the space, and reconfigure it, without installing anything.',
  },
  {
    q: 'Is it compatible with the software we already use?',
    a: 'Yes. We import from the formats every architectural package can export, so nothing changes about how your team draws. Playback runs in any modern browser, including on phones, tablets and VR headsets.',
  },
  {
    q: 'Can clients change the design themselves?',
    a: 'That is the point of the configurator. You decide which options are open — paint, flooring, fittings, furniture packages — and the client switches between them live. You see what they chose.',
  },
  {
    q: 'Do we need a 3D specialist on the team?',
    a: 'No. The plan detector does the geometry, and the material and lighting libraries are pre-built. If you can read a floor plan you can produce a walkthrough.',
  },
  {
    q: 'What does it cost?',
    a: 'Nothing right now. The platform is free while in beta — every account gets the full feature set, including renders. We will introduce paid plans later, and existing users will get notice well before anything changes.',
  },
  {
    q: 'What are credits, if it is free?',
    a: 'Credits meter the renders that run on our GPU machines, so one project cannot accidentally consume the whole pool. Free accounts get a generous monthly allocation and unused credits roll over. Nothing about credits involves payment today.',
  },
  {
    q: 'Who owns the models and renders we produce?',
    a: 'You do. Export the model and the stills whenever you want; nothing is locked to the platform.',
  },
  {
    q: 'Can several architects work on one project?',
    a: 'Yes — changes sync live between everyone in the scene, so two people editing the same model do not overwrite each other.',
  },
]

/**
 * Referral questions, kept separate from the product FAQ.
 *
 * The reference site merges the two into one ten-item accordion on the
 * homepage, which buries "how does the product work" under payout mechanics.
 * These render on the referral page, where someone is actually asking them.
 */
export const referralFaqs: Faq[] = [
  {
    q: 'What counts as a successful referral?',
    a: 'A new organisation that signs up using your code or link, and that was not already a customer. It is recorded at the moment the account is created — which is why the code has to be on the signup form rather than added afterwards.',
  },
  {
    q: 'How much do I earn?',
    a: 'Ten percent of what each referred organisation pays, every month, for as long as they stay subscribed. There is no cap on the number of referrals or on total earnings.',
  },
  {
    q: 'The product is free — so what am I earning on?',
    a: 'Nothing yet, and we would rather say so than show you a ₹0 balance and let you assume it is broken. Referrals are being recorded now, so the practices you introduce today still count when paid plans start.',
  },
  {
    q: 'Can I refer myself, or a second account at my own firm?',
    a: 'No. Self-referral is checked for and quietly not credited. It does not block the signup — the account is created normally, it just is not attributed.',
  },
  {
    q: 'What if someone mistypes my code?',
    a: 'The signup form checks the code as it is typed and shows which organisation it belongs to, so a typo is visible before the form is submitted. An unrecognised code never prevents someone from creating an account.',
  },
  {
    q: 'Can I track my referrals?',
    a: 'Yes — the referral page lists every organisation that has joined through your link and when, alongside your code and share link.',
  },
]
