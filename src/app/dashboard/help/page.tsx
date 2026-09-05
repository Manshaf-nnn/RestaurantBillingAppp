import type { Metadata } from 'next'
import Link from 'next/link'

import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { requirePageUser } from '@/server/auth/guard'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'How it works' }

/**
 * The guide, in the app rather than in a file nobody opens.
 *
 * Written after watching an owner type "sugar" into a box labelled "Storage
 * areas" — the only text box on that page — and conclude the system was broken.
 * It was a fair conclusion: nothing anywhere told him how stock gets in.
 *
 * Deliberately concrete. Every section names the screen it is talking about and
 * links to it, because a manual that explains concepts without saying where to
 * click is the kind nobody finishes.
 */
export default async function HelpPage() {
  await requirePageUser('/dashboard/help')

  return (
    <>
      <PageHeader
        title="How it works"
        description="Ten minutes here will save you a week of guessing. Everything below links to the screen it describes."
      />

      <div className="space-y-5">
        <SectionCard title="The one idea behind everything">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Stock is never a number anyone types. It is the running total of things that
            happened to it — arrived, sold, wasted, moved, cooked. Every one of those leaves a
            dated, named row in the stock ledger, and what you see on screen is the sum of
            those rows.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            That is why the books can always be proved right, and why there is a screen that
            proves them: <Guide href="/dashboard/reports/reconciliation">Reconciliation</Guide>.
          </p>
        </SectionCard>

        <SectionCard title="1 · Places" description="Everything happens somewhere.">
          <Rows
            rows={[
              ['Branch', 'Serves guests. Tables, a kitchen, a till.'],
              ['Central warehouse', 'Takes bulk deliveries and supplies the others. No guests.'],
              ['Production house', 'Makes food from raw materials. No guests.'],
            ]}
          />
          <Note>
            Inside any of them you can name <strong>storage areas</strong> — Cold room, Dry
            store, Bar. Those are <em>shelves</em>. They hold stock; they are not stock. Naming
            one &quot;Sugar&quot; does not give you any sugar.
          </Note>
          <Note>
            One restaurant with one kitchen never needs any of this. You get a location called
            Main and can forget it exists. <Guide href="/dashboard/locations">Locations</Guide>
          </Note>
        </SectionCard>

        <SectionCard title="1b · Units and categories" description="Set these up once.">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Every stock item picks a unit and a category.{' '}
            <Guide href="/dashboard/inventory/setup">Units &amp; categories</Guide> is where you name
            them, order them, and switch off the ones you never use so the dropdowns stay short.
          </p>
          <Note>
            The nine units are the ones the system can convert between — a kilo is a thousand grams,
            a dozen is twelve. Box, packet and bottle have no fixed size, so each item declares its
            own: &ldquo;bought as a box of 24&rdquo;. That is how you add a pack size we have never
            heard of.
          </Note>
          <Note>
            Retiring a category never touches the items in it. They keep it, and last year&apos;s
            reports keep working; it simply stops being offered for new ones.
          </Note>
        </SectionCard>

        <SectionCard title="2 · Getting stock in" description="Three ways, and only three.">
          <Rows
            rows={[
              [
                'A purchase order',
                'Choose the supplier, the items, and where the delivery lands. Raising the order moves nothing — an order is a promise. Stock exists when you press Receive and enter what actually turned up.',
              ],
              [
                '“Add stock here”',
                'On any location’s page. For your opening count, or a delivery that came without an order.',
              ],
              ['A transfer in', 'From another location. See below.'],
            ]}
          />
          <Note>
            You can receive <strong>less</strong> than you ordered — do. Record what arrived,
            not what was promised. The order stays open for the rest and the shortfall is
            visible. <Guide href="/dashboard/purchases">Purchases</Guide>
          </Note>
          <Note>
            <strong>An order must be approved before anything can be received against it.</strong>{' '}
            Approving is what commits the money, so it happens before the van arrives. A draft order
            will show its items and refuse to take a delivery, and will say so.
          </Note>
          <Note>
            <Guide href="/dashboard/purchases/receive">Goods received</Guide> lists everything
            waiting to be unloaded and what is still to come on each. That is the screen to open
            when a van turns up.
          </Note>
          <Note>
            While ordering or receiving, each item shows <strong>what you last paid</strong>, when,
            and to whom. Click the figure to use it; nothing is filled in behind your back. Enter
            what the supplier actually charged if it differs — that is what goes in the books.
          </Note>
        </SectionCard>

        <SectionCard
          title="2b · Every screen under Inventory"
          description="What each one is for, and when to open it."
        >
          <Rows
            rows={[
              [
                'Stock',
                'The list of everything you hold, and the only place items are created. The quantity shown is whichever location the switcher is on — pick Branch 02 and you see Branch 02’s shelf, not the group total.',
              ],
              [
                'Stock counts',
                'Walk the shelves, write down what is actually there, and let a manager sign off the difference. The one screen that can correct a balance in bulk.',
              ],
              [
                'Wastage',
                'What went in the bin, why, and what it cost. Always with a reason, because “we lost 4kg” and “the fridge failed” are different problems.',
              ],
              [
                'Expiry',
                'Every batch that is going off, soonest first, with the money at risk. Only items ticked “This goes off” appear here — see 2c.',
              ],
              [
                'Stock variance',
                'The history of your counts: what was expected, what was found, what it cost, and whether wastage on the day explains it.',
              ],
              [
                'Reconciliation',
                'Opening + in − out = closing, item by item. Proves the books add up.',
              ],
              [
                'Units & categories',
                'The two managed lists items pick from. Set these up once, first.',
              ],
            ]}
          />
          <Note>
            <strong>Adding an item.</strong> Name, unit, opening quantity, and — if you have more
            than one site — <strong>which location</strong> the opening quantity is at. That last
            one matters: an item is shared by the whole business, but its stock lives somewhere. Put
            10kg in at the warehouse and Branch 02 correctly shows nothing until you transfer some.
          </Note>
          <Note>
            <strong>“Alert me below”</strong> is the only threshold. At or under it the item is
            flagged Low and appears in reorder suggestions. Leave it at 0 and you simply get no
            warning — an item sitting at zero shows as <strong>Out</strong>, which is a fact, not an
            alert you configured.
          </Note>
        </SectionCard>

        <SectionCard
          title="2c · Counting, and things that go off"
          description="The two that need a worked example."
        >
          <p className="text-sm font-medium">A stock count, start to finish</p>
          <Rows
            rows={[
              [
                '1 · Start a count',
                'From Stock counts. It is opened against the location you are currently viewing — check the switcher first, because that is the shelf you are about to compare against.',
              ],
              [
                '2 · Count the shelf',
                'The sheet opens on what this location stocks; “All items” shows the rest, for when you find something the books have never heard of here. The system figure is deliberately hidden — if you are shown the number you are supposed to find, you stop counting and start agreeing.',
              ],
              [
                '3 · Send for approval',
                'Nothing has moved yet. A mistyped 5 instead of 50 is a wrong line on a draft, not a wrong balance.',
              ],
              [
                '4 · A manager approves',
                'Only now does stock change, as adjustments in the ledger with a name and a date on them. Whoever counted cannot approve their own sheet — that is the control that makes a count worth taking. Owners and admins can, because there is nobody above them to ask.',
              ],
            ]}
          />
          <Note>
            <strong>Worked example.</strong> The warehouse holds 40kg of rice and Branch 02 holds
            10kg. You count Branch 02 and find 10kg. Variance <strong>0</strong> — the count is
            compared against <em>Branch 02’s</em> 10kg, never the group’s 50kg. Find 7kg instead and
            it posts a 3kg shortfall <em>at Branch 02</em>; the warehouse is untouched. Find 3kg of
            something Branch 02 has never carried and approving it creates that stock there, which
            is exactly how you correct a location whose figures have drifted.
          </Note>
          <Note>
            <strong>Then read Stock variance.</strong> That 3kg shortfall appears there with what it
            cost. If someone recorded 3kg of wastage the same day, it is marked as explained.
            If not, it is unexplained loss — which is the number worth chasing.
          </Note>
          <p className="mt-5 text-sm font-medium">Things that go off</p>
          <Note>
            Tick <strong>“This goes off”</strong> on the item. From then on, every delivery of it
            asks for an expiry date and each delivery is tracked as its own batch — because this
            crate of milk goes off on Friday and the next one on Sunday. The oldest is always used
            first, and the Expiry tab fills up on its own.
          </Note>
          <Note>
            <strong>If the Expiry tab is empty</strong>, nothing you hold is marked as perishable
            yet, or no delivery of it has arrived since you ticked the box. It fills from{' '}
            <Guide href="/dashboard/purchases/receive">deliveries</Guide>, not from the item form.
          </Note>
        </SectionCard>

        <SectionCard
          title="2d · The live floor"
          description="One screen that answers 'how are we doing right now'."
        >
          <Rows
            rows={[
              [
                'The tiles',
                'Tables occupied, how many are still waiting on food, how many are late, and what share of everything ordered has actually gone out.',
              ],
              [
                'Waiting longest',
                'The order to walk the floor in. Longest wait at the top; a table drops off it the moment its last plate is served.',
              ],
              [
                'Tables',
                'One card per table — ordered, preparing, ready, served, and how far along. Tap one for who is sitting there.',
              ],
              [
                'Needs attention',
                'Only what is true right now. Nothing to tick off: fix the problem and the entry goes.',
              ],
            ]}
          />
          <Note>
            <strong>The clock starts when the order reaches the kitchen</strong> —
            not when somebody scans the QR code, not while they are still reading
            the menu. And it stops when the last plate goes out, so a table
            lingering over coffee is not counted as a failure.
          </Note>
          <Note>
            <strong>A second round is timed on its own.</strong> Order pudding an
            hour into a meal and the card counts from the pudding, not from when
            the party sat down — otherwise every long, happy table would look
            like a disaster.
          </Note>
          <Note>
            <strong>Progress counts plates, not tickets.</strong> Five items with
            two out is 40%. Anything you cancel leaves the sum entirely rather
            than counting against you.
          </Note>
          <Note>
            <strong>Guests you know are marked.</strong> First visit, returning,
            regular, VIP — worked out from completed visits, so the meal they are
            having right now never counts as one of them. Somebody back after a
            long gap is flagged separately, because a regular who has been away
            four months is both things at once and you would want to know.
          </Note>
          <Note>
            <strong>A walk-in shows as “not identified”, deliberately.</strong> If
            no phone number was taken there is no history to show, and inventing
            one would be worse than saying so.
          </Note>
          <Note>
            All the numbers — what counts as late, how many visits make a regular,
            how long a gap is worth a fuss — are yours to set under{' '}
            <Guide href="/dashboard/settings">Settings → Live floor</Guide>.
          </Note>
        </SectionCard>

        <SectionCard title="3 · Stock going out">
          <Rows
            rows={[
              [
                'A sale',
                'When the kitchen accepts an order, the recipe for each dish is read and the ingredients come off that branch’s shelves. Change the order and it corrects itself. Cancel it, or void a line at the till, and everything comes back. You never have to remember to undo anything.',
              ],
              [
                'Wastage',
                'Always with a reason — “we lost 4kg of chicken” and “the fridge failed” are different facts, and only the second lets you fix something.',
              ],
              ['A transfer out, or production consuming it', 'See below.'],
            ]}
          />
          <Note>
            Try to sell what you have not got and you will be stopped. You can turn that off in{' '}
            <Guide href="/dashboard/settings">Settings</Guide> if you would rather never block
            service — the balance then goes negative and shows as an alert instead.
          </Note>
        </SectionCard>

        <SectionCard
          title="4 · Moving stock between places"
          description="Four steps, because something real happens at each one."
        >
          <Rows
            rows={[
              ['Request', 'Nothing moves. A question: “can Kandy have 20kg of sugar?”'],
              [
                'Approve',
                'Sets 20kg aside at the source — reserved. Still on its shelf, but promised, so nobody can sell it out from under the transfer.',
              ],
              [
                'Dispatch',
                'The van leaves. The source loses 20kg; the destination shows 20kg in transit — on its way, not yet usable.',
              ],
              ['Receive', 'The van arrives. The destination gains what actually arrived.'],
            ]}
          />
          <Note>
            That middle part is the point: between dispatch and receipt the stock is nowhere
            anyone can sell it, and it is not lost either. If 18kg arrives instead of 20 you
            enter 18 and must say why. The 2kg does not quietly evaporate.
          </Note>
          <Note>
            To move stock between two shelves in the same place, pick the same location on both
            sides and choose two different storage areas. The total does not change; only where
            it sits. <Guide href="/dashboard/transfers">Transfers</Guide>
          </Note>
        </SectionCard>

        <SectionCard
          title="4b · Telling a branch what to do"
          description="The owner asks; the branch answers."
        >
          <p className="text-sm leading-relaxed text-muted-foreground">
            Leave an instruction for one location or for all of them. The managers there are
            notified, and it stays on their list until someone marks it done — with their name and
            what they found against it.
          </p>
          <Note>
            Use it for the things that used to happen on the phone: &quot;count the cold room before
            Friday&quot;, &quot;stop selling the fish curry&quot;. A month later you can still see
            whether it was done. <Guide href="/dashboard/tasks">Things to do</Guide>
          </Note>
          <Note>
            Only an owner or a group manager can write one. A manager assigned to a location can
            see and complete theirs, and cannot write instructions for anyone.
          </Note>
        </SectionCard>

        <SectionCard title="4c · Suppliers and what you owe" description="Every supplier has a statement.">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Open any supplier for their contact details, every order, every delivery, every payment,
            and a running balance.
          </p>
          <Rows
            rows={[
              ['Received', 'Goods that have actually arrived. This is what you owe.'],
              ['Paid', 'What you have paid them. Record it and the balance keeps itself right.'],
              ['Still on order', 'Ordered, not delivered. Not owed to anyone yet.'],
            ]}
          />
          <Note>
            An order is a promise, so it never appears as a debt. You owe for what came off the van,
            which is why a 400,000 order with 50,000 delivered shows 50,000 outstanding.{' '}
            <Guide href="/dashboard/suppliers">Suppliers</Guide>
          </Note>
          <Note>
            Every reference on the statement is a link. Click a figure to reach the delivery, the
            delivery to reach the order, the order to reach the items.
          </Note>
        </SectionCard>

        <SectionCard title="5 · Cash and the till" description="Two piles of money, never mixed.">
          <Rows
            rows={[
              [
                'Opening cash',
                'The change float in the drawer. Cash sales add to it; refunds, drops and anything paid out take from it.',
              ],
              [
                'Opening petty cash',
                'A separate tin you buy small things from — a three-wheeler to the market, cleaning cloths. Sales never touch it. If you have no tin, leave it blank.',
              ],
            ]}
          />
          <Note>
            What the system expects to find in the drawer:{' '}
            <strong>
              opening cash + cash sales + anything put in − refunds, drops, deposits and anything
              paid out
            </strong>
            . It is worked out fresh every time it is shown, never kept as a running total, so a
            payment that arrives late cannot quietly put it out.
          </Note>
          <Note>
            Card, QR, online and bank transfers appear on the close screen so you can see the
            whole shift, but they never change the drawer figure. That money never entered it.
          </Note>

          <p className="mt-4 text-sm font-medium">What &ldquo;opening float&rdquo; means</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            The float is the change you start with so you can serve the first customer — say
            Rs 10,000 in fives, tens and hundreds. <strong>It is not takings.</strong> If you
            open with Rs 10,000, sell nothing all day and count Rs 10,000 at close, you have
            balanced perfectly and earned nothing. The float is measured so that everything
            after it can be measured against it.
          </p>
          <Note>
            Count it before the first sale, not after. A float typed from memory is a variance
            waiting to appear at midnight with nobody able to say which end it came from.
          </Note>

          <p className="mt-4 text-sm font-medium">A shift, in figures</p>
          <Rows
            rows={[
              ['Open', 'Cash 10,000 in the drawer · 5,000 in the petty cash tin'],
              ['Cash sales', '+50,000 — attaches itself, nothing to press'],
              ['Card sales', '20,000 — shown at close, never in the drawer'],
              ['More change brought up', '+2,000 (Cash in → Additional float)'],
              ['A refund', '−1,000 — recorded when you refund the payment'],
              ['Three-wheeler to the market', '−400 from the drawer (petty cash, paid from drawer)'],
              ['Cleaning cloths', '−800 from the tin (petty cash, paid from tin)'],
              ['To the safe', '−20,000 (Cash out → Cash drop)'],
              ['Expected in the drawer', '40,600 · and 4,200 left in the tin'],
            ]}
          />
          <Note>
            Count 40,100 and the screen says <strong>short by 500</strong> before you press
            anything, and asks why. Write the answer while you still have one.
          </Note>
        </SectionCard>

        <SectionCard title="5a · Starting a shift" description="Before the till will open.">
          <p className="text-sm leading-relaxed text-muted-foreground">
            A cashier signing in is asked to open a drawer before they can reach the till. Cash
            taken with no drawer open belongs to no shift and can never be counted against
            anything — so this comes first, and it is the whole reason for the screen.
          </p>
          <Rows
            rows={[
              ['Branch', 'Only asked if they can work at more than one.'],
              ['Till', 'Only asked if that branch has more than one counter.'],
              ['Opening cash', 'Count the change in the drawer and type it.'],
              ['Opening petty cash', 'The tin, counted separately.'],
            ]}
          />
          <Note>
            <strong>The second box is not the drawer.</strong> It is the tin you buy small things
            from. Typing the float into both is the one mistake worth warning about — the fund is
            then wrong from the first shift and every petty cash figure after it inherits that.
            Blank is correct if there is no tin.
          </Note>
          <Note>
            Managers and owners never see this screen; they are not stopped by it. If your
            operation genuinely handles no cash you can switch the whole thing off in{' '}
            <Guide href="/dashboard/settings">Settings → Cash controls</Guide>.
          </Note>
          <Note>
            One person, one drawer; one till, one person. Nobody can open a second drawer while
            they hold one, and nobody can open a till somebody else is standing at.
          </Note>
        </SectionCard>

        <SectionCard title="5b · During service" description="Most of it looks after itself.">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Cash sales attach themselves to whoever took them, at the branch they were taken at.
            There is nothing to press. Everything else that moves notes gets a row, with a reason
            — an unexplained movement is indistinguishable from theft when the drawer is counted.
          </p>
          <Rows
            rows={[
              ['Additional float', 'More change brought up to the till.'],
              ['Cash drop', 'Skimmed to the safe so the till is not holding the day’s takings.'],
              ['Bank deposit', 'Taken to the bank.'],
              ['Paid out', 'A supplier at the door, a courier.'],
              ['Top up petty cash', 'Moves money from the drawer into the tin.'],
            ]}
          />
          <Note>
            Two kinds are written by the system and are deliberately not in that list: a{' '}
            <strong>cash refund</strong> and a <strong>petty cash payment</strong>. Both are
            recorded by the thing that performs them. Posting one by hand as well would put the
            same rupees in the ledger twice.{' '}
            <Guide href="/dashboard/cash-drawer">Cash drawer</Guide>
          </Note>
        </SectionCard>

        <SectionCard title="5c · Petty cash" description="Raise it, approve it, then pay it.">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Small cash expenses go through three steps, and only the last one moves money. A
            request that is approved but not yet paid has changed nothing; the notes are still in
            the tin.
          </p>
          <Rows
            rows={[
              ['Raise', 'Category, what it was for, how much, and which tin it comes out of.'],
              ['Approve', 'A manager says yes. Still nothing has moved.'],
              ['Pay out', 'The notes change hands. This is the step that costs money.'],
            ]}
          />
          <Note>
            <strong>Which tin</strong> matters. Paid from the tin, it comes off the fund and the
            drawer is untouched. Paid from the drawer, it writes a movement and lowers what the
            till should hold. It is never taken off both.
          </Note>
          <Note>
            Above a limit you set, the person who asked cannot be the person who approves. Below
            it they can, so a manager buying a bag of cloths does not have to find a second
            manager — a control everybody trips over every night stops being a control.{' '}
            <Guide href="/dashboard/petty-cash">Petty cash</Guide>
          </Note>
        </SectionCard>

        <SectionCard title="5d · Closing, and handing over" description="Two ways a shift ends.">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Count what is physically in the drawer and enter it. The difference is shown as you
            type, and it is <strong>recorded, not corrected</strong> — a till that is short by 500
            is a fact the owner needs to see, not an error to round away.
          </p>
          <Rows
            rows={[
              [
                'If it balances',
                'The drawer closes. The till is free for the next person.',
              ],
              [
                'If it does not',
                'You must say why, before it will close. Nobody remembers this tomorrow, and the sentence written on the night is the only one worth having.',
              ],
              [
                'If the gap is large',
                'It stops for a manager to sign off, and takes no more money while it waits — so the count it is holding cannot go stale. The manager cannot be the person who counted it.',
              ],
            ]}
          />
          <Note>
            Leaving mid-service instead? Use <strong>Hand over</strong>. You count, pick who is
            taking it, and your session closes; they confirm on their own screen and a new session
            opens with what you counted as its float. The tin goes with it.
          </Note>
          <Note>
            It works that way rather than passing your session along because a drawer that is
            short has to belong to one person. A session with two names on it cannot answer the
            only question it exists to answer.{' '}
            <Guide href="/dashboard/handover">Shift handover</Guide>
          </Note>
          <Note>
            Closed drawers never disappear. Every session, its variance and the reason given are
            on <Guide href="/dashboard/reports/cash-drawer">the cash drawer report</Guide>,
            filterable by branch, cashier, till, status and date, and exportable. Open any
            session number for every movement in it, who recorded each one, and the audit trail.
          </Note>

          <p className="mt-4 text-sm font-medium">If somebody forgets to close</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Their session keeps the till, and the next cashier cannot start on it. An owner or
            manager sees it under <strong>Open right now</strong> on{' '}
            <Guide href="/dashboard/cash-drawer">Cash drawer</Guide> — whose it is, which till,
            and what it should be holding — and can close it for them.
          </p>
          <Rows
            rows={[
              [
                'You can count it',
                'Enter what is really there. The difference is recorded against the cashier whose shift it was, not against you.',
              ],
              [
                'You cannot count it',
                'Say so. The variance is recorded as unknown — never as zero, because zero would claim the till balanced when nobody looked.',
              ],
            ]}
          />
          <Note>
            Either way you have to say why, and the record shows it was closed by a manager
            rather than by the person who opened it. The till is free immediately.
          </Note>
        </SectionCard>

        <SectionCard
          title="5e · Who was working"
          description="Recorded from signing in. Nobody has to remember anything."
        >
          <Rows
            rows={[
              [
                'Clocking in',
                'Signing in starts a shift — with a password, a staff code, or an access link. There is no separate button to press and nothing to forget.',
              ],
              [
                'Clocking out',
                'The shift ends at the last thing the person actually did, not when they closed the tab. Somebody who finishes at ten and signs out at eleven worked until ten.',
              ],
              [
                'Where it counts',
                'A shift belongs to one location. Sign in at another and the first one closes and a second begins, so an evening covering Branch 2 is Branch 2’s hours and Branch 2’s sales.',
              ],
              [
                'Seeing it',
                'A location → Hours & performance. Your own are on your profile page, whatever your role.',
              ],
            ]}
          />
          <Note>
            <strong>Why not just “signed in until signed out”.</strong> Almost
            nobody signs out — they close the laptop — and a session stays valid
            for a month. Ending a shift at the last real action is the only rule
            that does not quietly bill a fortnight for a Tuesday.
          </Note>
          <Note>
            <strong>Forgotten shifts close themselves.</strong> Ninety minutes
            with nothing done and it ends, dated to that last action. Anything
            still running after sixteen hours is closed and flagged for you to
            look at — that is a mistake, not a shift.
          </Note>
          <Note>
            <strong>A night shift stays on one day.</strong> Six in the evening
            until half one in the morning is one shift of seven and a half hours,
            counted under the evening it started. So on <em>Today</em> that
            person looks absent until they do something.
          </Note>
          <Note>
            <strong>Shared screens are not counted.</strong> A kitchen display
            everybody uses is one account shared by everyone who touches it — it
            cannot say who was there, so it says nothing rather than guessing.
          </Note>
          <Note>
            <strong>Wrong hours can be fixed, and the original is kept.</strong>{' '}
            Somebody works a morning and forgets to sign in; somebody checks the
            rota from home and opens a shift they never worked. A manager
            corrects it with a reason, and both what happened and what was
            decided stay on the record — which is the point, in the one
            conversation where it matters.
          </Note>
        </SectionCard>

        <SectionCard
          title="5f · How people are doing"
          description="Three separate answers, never one score."
        >
          <Rows
            rows={[
              [
                'Attendance',
                'Hours, days, and who is on shift right now. The one figure that means the same thing for every job.',
              ],
              [
                'Served vs rung',
                'Served is whose table it was. Rung is who keyed it in. A cashier ringing up a waiter’s table is normal, so these are two numbers and never added together.',
              ],
              [
                'Activity',
                'Every recorded action at that location, newest first — who adjusted stock, who approved a count, who refunded a bill.',
              ],
            ]}
          />
          <Note>
            <strong>Counter sales are rung, not served.</strong> Somebody has to
            own a walk-in, so the till operator is recorded against it — but they
            were not waiting a table, and counting it as service would put your
            busiest cashier top of a list of your best waiters.
          </Note>
          <Note>
            <strong>QR orders belong to nobody</strong>, because a guest ordering
            from their own phone has no server and no cashier. That money is
            shown separately as <em>not attributed</em> rather than left out, so
            everyone’s figures plus that number is the branch total.
          </Note>
          <Note>
            <strong>Do not rank different jobs against each other.</strong> A
            cook rings up nothing, so a sales table says they did nothing — which
            is false. Kitchen work is not recorded per person yet, and the screen
            says so rather than showing a zero.
          </Note>
        </SectionCard>

        <SectionCard title="6 · Recipes" description="More important than they look.">
          <p className="text-sm leading-relaxed text-muted-foreground">
            A recipe links a dish to what it uses. Without one, selling a burger takes
            nothing off any shelf and your food cost is unknowable.
          </p>
          <Rows
            rows={[
              [
                'Recipe',
                'What one plate of a dish uses. One burger = 1 patty, 2 bun halves, 1 slice of cheese.',
              ],
              [
                'Make-ahead recipe',
                'Something the kitchen makes in advance and puts on the shelf — sauce, stock, dough, patties. A dish recipe can then use “50 g of burger sauce” as if it were any other ingredient.',
              ],
            ]}
          />
          <Note>
            <strong>Where they live.</strong> A dish&apos;s recipe is on the Recipes screen.
            A make-ahead recipe is on the Kitchen jobs screen, next to the button that makes
            it. There used to be a third place — a Recipe tab inside the menu item — that
            saved happily and was then ignored. It is gone.
          </Note>
          <Note>
            Each line takes a <strong>wastage %</strong> for trim, peel and spillage. If 100 g
            reaches the plate but 105 g leaves the store, say 5% and the books will match the
            bin.
          </Note>
          <Note>
            <strong>Made-ahead things come off the shelf.</strong> If a burger uses 50 g of a
            sauce you made this morning, selling it takes 50 g of <em>sauce</em>. It does not
            take the tomatoes again — those left stock when you made the sauce.
          </Note>
          <Note>
            Edit a recipe that has already been sold against and the old version is kept.
            Last month&apos;s cost stays last month&apos;s cost — otherwise editing a recipe
            silently rewrites every margin you have ever reported.{' '}
            <Guide href="/dashboard/recipes">Recipes</Guide>
          </Note>
        </SectionCard>

        <SectionCard title="7 · Kitchen jobs" description="For anything you make rather than buy.">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Bread, sauces, marinades, butchered cuts. Ingredients go in, a new stock item
            comes out. It happens at a <strong>production house</strong>, because making things
            is a different job from serving guests.
          </p>
          <Rows
            rows={[
              ['1 · Add the job', '“Make 100 loaves.” Nothing moves.'],
              ['2 · Approve', 'Someone senior signs it off. Nothing moves.'],
              [
                '3 · Mark it done',
                'Enter how many actually came out. Only now do the ingredients come off the shelves, the finished item appear, and the cost get worked out.',
              ],
            ]}
          />
          <Note>
            <strong>You say how many, not how many batches.</strong> This screen used to ask
            for a number of batches against a recipe that made ten of something, so &ldquo;10&rdquo;
            quietly meant a hundred loaves. Now 100 means 100.
          </Note>
          <div className="mt-3 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
            <p className="font-medium">Why a bad day costs you more per loaf</p>
            <p className="mt-1 text-muted-foreground">
              You asked for 100 loaves, so 100 kg of flour went into the mixers. Only 80 came
              out; the rest caught and were binned. <strong>All 100 kg is used up</strong> — it
              went in whether or not it became bread — and the cost is spread over the 80 loaves
              you actually got. Each loaf costs more than it would on a good day.
            </p>
            <p className="mt-2 text-muted-foreground">
              That is the true picture. A system that quietly used only 80 loaves&apos; worth
              would report a disastrous day as perfectly efficient, and you would never learn
              that your night shift was burning a fifth of your flour.
            </p>
          </div>
          <Note>
            <strong>Other costs.</strong> When you mark a job done you can add what the labour,
            power and gas cost. It is spread over the output along with the ingredients, so the
            cost per loaf is what it really cost — not just what the flour cost.
          </Note>
          <Note>
            <strong>If none came out</strong>, cancel the job instead of entering zero. A
            cancelled job takes nothing from stock; entering zero would use every ingredient
            and give you nothing to show for it.
          </Note>
          <Note>
            Click any job number to see it in full: what went in, what came out, what the gap
            cost, and who approved it.
          </Note>
          <Note>
            Recipes can be edited or retired. Editing changes future jobs only — jobs already
            done keep the costs they were done with, so last month&apos;s margins never move
            under you.
          </Note>
          <Note>
            Prepared items — sauces, pastes, dough — are made from stock at any branch and become stock
            themselves, usable in any recipe. Send them elsewhere with a normal transfer.{' '}
            <Guide href="/dashboard/production">Kitchen Production</Guide>
          </Note>
        </SectionCard>

        <SectionCard title="8 · Who sees what">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Everyone signs in with their <strong>email</strong> and their{' '}
            <strong>sign-in code</strong> — eight characters on a card. Their{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">W-0003</code> is a different
            thing: that is their ID, the one on dockets and in &quot;who served table 4&quot;.
          </p>
          <Note>
            Assign someone to a location and they see only that location. Leave it blank and
            they see everything — that is your group manager.{' '}
            <Guide href="/dashboard/staff">Staff</Guide>
          </Note>
          <Note>
            <strong>The location switcher in the top bar changes everything below it.</strong> Pick
            Kandy and the takings, the orders, the stock quantities, the tables and the reorder
            list are all Kandy&apos;s. Pick &quot;All locations&quot; for the group. Your choice is
            remembered, and the address bar carries it — so a filtered view can be bookmarked or
            sent to your accountant.
          </Note>
          <Note>
            On a transfer, each step belongs to one end: the sending location approves and
            dispatches, the receiving location receives. Either end can ask for it, and either end
            can call it off. Buttons you cannot use are not shown.
          </Note>
        </SectionCard>

        <SectionCard title="9 · Proving the books">
          <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed">
{`Opening              100 kg
  + purchases         50 kg
  − sold              30 kg
  − wasted             5 kg
  = closing          115 kg   ← what the ledger says
    stored quantity  115 kg   ← what the system holds
    drift              0      ← must be zero`}
          </pre>
          <Note>
            <strong>Drift must be zero.</strong> Anything else means a balance changed with no
            movement behind it, and every figure from that item — value, margin, reorder
            level — is wrong from that moment.{' '}
            <Guide href="/dashboard/reports/reconciliation">Reconciliation</Guide>
          </Note>
        </SectionCard>

        <SectionCard title="9b · How the numbers are computed" description="The definitions every screen shares — so a figure here always matches the same figure anywhere else.">
          <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed">
{`Net sales   = goods sold − discounts − refunds
              (never tax, never service charge, never tips)
Collected   = payments in − refunds out       ← cash-basis, shown BESIDE net sales
Owed        = bill total + tip − paid so far
COGS        = what the sold food's ingredients cost, at the weighted
              average when the kitchen accepted each order
Gross profit = net sales − COGS
Purchases   ≠ COGS: money spent on stock is not money's worth of food sold`}
          </pre>
          <Note>
            The tip is the staff&rsquo;s money riding on top of the bill — it appears on
            receipts and in what a guest owes, and in <strong>no</strong> revenue figure.
            Every report runs on the restaurant&rsquo;s own timezone, so &ldquo;today&rdquo;
            rolls over at your midnight. The daily close freezes a day&rsquo;s figures
            exactly as signed.{' '}
            <Guide href="/dashboard/reports/daily-close">Daily close</Guide>
          </Note>
        </SectionCard>

        <SectionCard title="10 · Setting up, in order">
          <ol className="list-inside list-decimal space-y-1.5 text-sm text-muted-foreground">
            <li><Guide href="/dashboard/settings">Settings</Guide> — name, currency, tax</li>
            <li>
              <Guide href="/dashboard/inventory/setup">Units &amp; categories</Guide> — name your
              units and set up the categories you group stock by
            </li>
            <li><Guide href="/dashboard/locations">Locations</Guide> — branches, warehouse, production house</li>
            <li><Guide href="/dashboard/staff">Staff</Guide> — add people, set where they work, hand out sign-in codes</li>
            <li><Guide href="/dashboard/inventory">Stock</Guide> — create your items with their units</li>
            <li>Opening figures — &quot;Add stock here&quot; on each location, or a purchase order</li>
            <li><Guide href="/dashboard/menu">Menu</Guide> — categories and dishes with prices</li>
            <li>
              <Guide href="/dashboard/recipes">Recipes</Guide> — link each dish to what it uses.{' '}
              <strong>Do not skip this.</strong> Without recipes nothing depletes and your food
              cost is guesswork
            </li>
            <li><Guide href="/dashboard/tables">Tables</Guide>, then print the <Guide href="/dashboard/qr">QR codes</Guide></li>
            <li>
              <Guide href="/dashboard/settings">Cash controls</Guide> — how far a drawer may be
              out before a manager has to sign it off, and how much petty cash needs a second
              approver. Add a second till to a branch only if it really has two counters
            </li>
            <li>
              If you have more than one location, use the switcher in the top bar and leave{' '}
              <Guide href="/dashboard/tasks">instructions</Guide> for each manager
            </li>
            <li>Sell something, then check <Guide href="/dashboard/reports/reconciliation">Reconciliation</Guide> balances</li>
          </ol>
        </SectionCard>

        <SectionCard title="Finding things">
          <p className="text-sm leading-relaxed text-muted-foreground">
            The search box at the top finds stock items, suppliers, purchase orders, deliveries,
            orders, customers and staff — by name, code, number, phone or invoice reference. Press{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">⌘K</code> (or{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">Ctrl K</code>) from anywhere.
          </p>
          <Note>
            You only ever find what you are allowed to open, and only at the locations you can see.
            A search that showed you a record and then refused to open it would be telling you it
            exists, which is the thing the permission is for.
          </Note>
          <Note>
            Big lists — purchases, suppliers, transfers, the audit log — have their own search box
            that looks through everything, not just the rows currently on screen.
          </Note>
          <Note>
            Report rows are clickable. Read that Sugar was the biggest wastage this month and click
            straight through to Sugar.
          </Note>
        </SectionCard>

        <SectionCard title="Words you will see">
          <Rows
            rows={[
              ['Available', 'On the shelf, sellable now'],
              ['Reserved', 'On the shelf, but promised to an approved transfer'],
              ['In transit', 'Dispatched, not yet arrived. Not sellable at either end'],
              ['Batch (production)', 'One run of a recipe. 10 batches of a 10-loaf recipe = 100 loaves'],
              ['Batch / lot (stock)', 'A delivery with its own expiry date, used oldest-first'],
              [
                'Variance',
                'The gap between expected and actual — of stock on a shelf, or cash in a drawer. Always needs a reason',
              ],
              ['Float', 'The change you start a shift with. Not takings'],
              ['Till / register', 'One physical counter. One open drawer at a time'],
              ['Petty cash', 'A separate tin for small cash expenses. Never the drawer'],
              ['Drop', 'Cash skimmed from the till to the safe mid-shift'],
              ['Drift', 'Stored balance minus ledger sum. Must be zero'],
              ['Shift', 'Attendance — who was working, where, and for how long'],
              ['Drawer session', 'Money accountability. Not a shift; you can work without touching cash'],
              ['Last action', 'The last thing somebody did. Where a shift ends'],
              ['Variance (count)', 'Counted minus what the books said, for one location'],
              ['Alert me below', 'Your low-stock threshold. 0 means no warning, not "warn always"'],
              ['Out vs Low', 'Out is nothing on the shelf. Low is under the threshold you set'],
              ['COGS', 'What the ingredients cost. Revenue − COGS = gross profit'],
              ['Spec', 'A production recipe'],
            ]}
          />
        </SectionCard>
      </div>
    </>
  )
}

function Rows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="space-y-3">
      {rows.map(([term, meaning]) => (
        <div key={term} className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:gap-4">
          <dt className="text-sm font-medium">{term}</dt>
          <dd className="text-sm leading-relaxed text-muted-foreground">{meaning}</dd>
        </div>
      ))}
    </dl>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 border-l-2 border-border pl-3 text-sm leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

function Guide({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="font-medium text-primary underline-offset-2 hover:underline">
      {children}
    </Link>
  )
}
