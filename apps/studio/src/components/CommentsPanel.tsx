import { useEffect, useState } from 'react'

import { deleteComment, listComments, type VisitorComment } from '../lib/api'

interface Props {
  sceneId: string
}

/**
 * What visitors said about the published walkthrough.
 *
 * ── Why this is read-only plus delete ───────────────────────────────────────
 * A reply channel means the visitor must be reachable, which means collecting
 * contact details on the published page, which turns a feedback box into a
 * lead form with legal weight. The buyer already has the developer's number —
 * it is in the site footer this product generates. Notes flow one way; the
 * conversation happens where it already happens.
 *
 * React escapes the text it renders, which is the entire XSS story for
 * visitor-typed content shown to the owner — as long as nothing here ever
 * takes a detour through innerHTML.
 */
export default function CommentsPanel({ sceneId }: Props) {
  const [comments, setComments] = useState<VisitorComment[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void listComments(sceneId)
      .then((list) => {
        if (!cancelled) setComments(list)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load notes.')
      })
    return () => {
      cancelled = true
    }
  }, [sceneId])

  // No notes is the common case, and a permanently empty panel trains the eye
  // to skip the space where a real note will one day sit. Render nothing.
  if (error || comments === null || comments.length === 0) return null

  return (
    <section>
      <span className="eyebrow">Notes from visitors</span>
      {comments.map((comment) => (
        <div key={comment.id} style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.5 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <strong style={{ flex: 1 }}>
              {comment.name ?? 'Anonymous'}
              {comment.view ? <span className="note"> · at {comment.view}</span> : null}
            </strong>
            <span className="note">{new Date(comment.at).toLocaleDateString()}</span>
            <button
              className="icon-btn"
              aria-label="Delete this note"
              onClick={() =>
                void deleteComment(sceneId, comment.id).then(() =>
                  setComments((current) => current?.filter((c) => c.id !== comment.id) ?? null),
                )
              }
            >
              ×
            </button>
          </div>
          <p style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap' }}>{comment.message}</p>
        </div>
      ))}
    </section>
  )
}
