import type { TransferSummary } from './queries'

/**
 * Which of the four lists a transfer belongs in for THIS viewer, and what it
 * is waiting for (recorrection.md §1).
 *
 * "In progress" was one bucket, and the question anyone opening the list has
 * — is this waiting on ME? — needs the status AND which end they stand at.
 * Pending approval and dispatch are the source's; pending receive is the
 * destination's. Its own module, rather than a helper inside the page, so
 * the filing can be pinned by a test without rendering anything.
 */
export type TransferSection = 'approval' | 'dispatch' | 'receive' | 'closed'

export function sectionFor(
  t: Pick<TransferSummary, 'status' | 'fromName' | 'toName'>,
  atSource: boolean,
  atDestination: boolean,
): [TransferSection, string] {
  switch (t.status) {
    case 'REQUESTED':
      return ['approval', atSource ? 'Waiting on you to approve' : `Waiting for ${t.fromName} to approve`]
    case 'APPROVED':
      // The destination's view of an approved transfer is "mine is coming":
      // it belongs with what they are waiting to receive, not with a
      // dispatch they cannot perform.
      return atSource
        ? ['dispatch', 'Waiting on you to dispatch']
        : ['receive', `Approved — waiting for ${t.fromName} to dispatch`]
    case 'DISPATCHED':
    case 'IN_TRANSIT':
      return ['receive', atDestination ? 'Waiting on you to receive' : `On its way — waiting for ${t.toName} to receive`]
    case 'RECEIVED':
      return ['receive', atDestination ? 'Received — waiting on you to confirm' : `Received at ${t.toName} — waiting for them to confirm`]
    default:
      return ['closed', '']
  }
}
