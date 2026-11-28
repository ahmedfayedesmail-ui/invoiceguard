# Campaign part 3 changed again (Nov 28 2026): owner decision on CorrectionReversal
Owner decision (Ahmed via Main, Nov 28 09:16): every CorrectionReversal needs a documented human decision for the whole pair before any credit note is issued.
The P3 scenario used to expect the credit note on the first pass. It now expects: first pass issues nothing and leaves one OPEN CORRECTION_PAIR_REVIEW finding; the decision (user, reason, fingerprint) issues nothing by itself; the next pass issues the credit note. Every later assertion is unchanged. Assertions were added, so the total rises from 10358 to 10658 (it is a changed case, not a moved metric). Ground truth, denominators and tolerance are untouched.

## Fix of my own assertion (owner review of ca032bb, Nov 28)
The first version took the call-count snapshot AFTER the first pass and compared it with itself, so it proved nothing about an upload. The snapshot is now taken before the pass and the assertion requires calls.length unchanged after it. (test R1 proved the same thing separately.) Mutation check: with the review bypassed, part 3 fails (the held-for-review assertion fires); restored afterwards.
