# 97. An amend to the marked round moves it back one, unless the reviewer is Attended

2026-08-11 · narrows 74

**Context:** entry 74's mark is permanent for the life of a round, precisely so that further
arrivals on a board the reviewer has not returned to raise nothing more. It was built for a round
whose *content* does not move once it has had its one banner, and nothing distinguished that case
from a round that changed under the mark: a re-post that amended the exact round the mark named
replaced its content while the reviewer was still gone, and the permanent mark kept that new
content as silent as if the round had already been announced -- which, in the sense that matters,
it had not. A first attempt cleared the mark to nothing on such an amend, and that was itself a
defect: a board can carry more than one awaited-open round at once (an awaited page round beside a
later question round, entry 45), and a page round is never sent, so it stays "waiting" for the rest
of the board's life. `nextToAnnounce` always names the OLDEST such round past the mark, not the one
this call is about -- so a mark of zero reopened every round at or below the one just amended, not
only that one, and an OLDER round already announced and already returned from rang a second time
while the round genuinely amended, the whole point of the fix, stayed silent. **Decision:** an
amend to the round a board's mark currently names moves the mark back to exactly one below that
round's number, with the gate forced open, provided the board is genuinely unattended at that
moment -- the narrowest change that still frees the amended round: `nextToAnnounce` lands on it
again, the same round `announce` would find for a brand-new arrival, and nothing at or below stays
any less accounted for than it already was. Gated on attendance rather than unconditional: a board
the reviewer is currently on, or inside its look-away window, is already mid-decision in
`evaluate`'s own attended branches on the same event, and those need the mark still naming the
round it actually announced to open the return gate on correctly -- moving it out from under that
decision would silently lose "the reviewer was genuinely here" the next time the board is left,
turning a real return into a false absence. **Consequences:** a round amended while nobody is
watching earns a fresh grace and, if still unwatched when it elapses, a second banner for content
the first banner never described -- narrowing entry 74's "at most once ever" to "at most once per
version of the round's content while unattended," and only for that one round: nothing else the
mark already accounted for is reopened. A round amended while the reviewer is present or recently
present is unaffected: the ordinary Attended/return-gate machinery already covers it correctly,
using the standing mark.
