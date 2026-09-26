// THE REVIEW-PAGE LOCKDOWN half of filingBackstop.dom.smoke.ts (same fixture, its own process, so
// each file stays well inside the DOM runner's 600 s budget): toReview300 / toReview1500 /
// toReviewForm (the review page's own script posts by fetch or by form submit — aborted, named
// stop, and the person's submit after hand-off goes through), toSummary (the run's own lock), the
// mid-flow postback latency pin, and the learner's backstop on a review page.
//
// Run: npx tsx portal-bot/src/filingBackstopReview.dom.smoke.ts
process.env.BACKSTOP_SMOKE_PART = "review";
await import("./filingBackstop.dom.smoke");
export {};
