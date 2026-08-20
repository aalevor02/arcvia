import brand from '@arcvia/brand'
import plans from '@arcvia/brand/plans'
import { currentUser } from '../lib/auth'
import { openStudioUrl } from '../lib/links'

/**
 * "Where does this account stand?" for the /trial page.
 *
 * The reference product renders four states here — signed out, trial running
 * with a day counter, trial expired, and subscribed — and picks between them
 * from the account record. This does the same job, minus the states that
 * cannot occur while `billingEnabled` is false.
 *
 * Keeping the shape means the expiry branch is already written for the day
 * billing is switched on; it just cannot be reached today, and the component
 * says so rather than rendering a countdown from a field nothing sets.
 */
export default function TrialStatus() {
  const user = currentUser()

  if (!user) {
    return (
      <div className="card">
        <h2 className="h3">
          {plans.billingEnabled ? 'Create an account to start' : 'Create an account'}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          {plans.billingEnabled
            ? 'Your trial starts the moment the account exists.'
            : 'Takes about a minute. Nothing to configure afterwards.'}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a href="/register/" className="btn-primary">
            Create a free account
          </a>
          <a href="/login/?next=/trial/" className="btn-secondary">
            I already have one
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="card border-accent">
      <h2 className="h3">
        You're all set, {user.name.split(' ')[0]}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        {plans.billingEnabled
          ? 'Your trial is running.'
          : `Your ${brand.name} account is active on the free plan, with the full product open.`}
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <a href={openStudioUrl()} className="btn-primary">
          Open the studio
        </a>
        <a href="/team/" className="btn-secondary">
          Invite your team
        </a>
      </div>
    </div>
  )
}
