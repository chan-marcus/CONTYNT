import { motion } from "motion/react";
import { CheckCircle, Lock, DollarSign } from "lucide-react";

const steps = [
  { label: "Claim Feature", state: "done" },
  { label: "Reel Submitted", state: "done" },
  { label: "Under Review", state: "active" },
  { label: "Payout Released", state: "locked", icon: "💰" },
];

function ShimmerReel() {
  return (
    <div className="relative w-full max-w-[260px] mx-auto" style={{ aspectRatio: "9/16" }}>
      {/* Background glow */}
      <motion.div
        className="absolute inset-0 rounded-3xl blur-2xl"
        style={{ background: "radial-gradient(ellipse at center, rgba(99,102,241,0.35) 0%, rgba(0,0,0,0) 70%)" }}
        animate={{ scale: [1, 1.08, 1], opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* Card */}
      <div className="relative w-full h-full rounded-3xl overflow-hidden border border-white/10 shadow-2xl bg-neutral-900">
        {/* Blurred gradient background simulating a reel */}
        <div className="absolute inset-0">
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-900/60 via-neutral-900 to-purple-900/40" />
          <div className="absolute top-1/4 left-1/4 w-1/2 h-1/2 rounded-full bg-indigo-500/20 blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 w-1/3 h-1/3 rounded-full bg-purple-500/20 blur-3xl" />
        </div>

        {/* Shimmer sweep */}
        <motion.div
          className="absolute inset-0 z-10"
          style={{
            background: "linear-gradient(105deg, transparent 35%, rgba(255,255,255,0.06) 50%, transparent 65%)",
          }}
          animate={{ x: ["-100%", "200%"] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "linear", repeatDelay: 1 }}
        />

        {/* Dark overlay */}
        <div className="absolute inset-0 bg-black/40 z-20" />

        {/* Centered content */}
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 px-6">
          {/* Pulsing ring */}
          <div className="relative flex items-center justify-center">
            <motion.div
              className="absolute w-14 h-14 rounded-full border border-white/20"
              animate={{ scale: [1, 1.6], opacity: [0.6, 0] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "easeOut" }}
            />
            <motion.div
              className="absolute w-14 h-14 rounded-full border border-white/10"
              animate={{ scale: [1, 1.9], opacity: [0.4, 0] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "easeOut", delay: 0.4 }}
            />
            <div className="w-14 h-14 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 flex items-center justify-center">
              <motion.div
                className="w-4 h-4 rounded-full bg-yellow-400"
                animate={{ opacity: [1, 0.4, 1] }}
                transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
              />
            </div>
          </div>

          <div className="text-center">
            <p className="text-white text-base font-semibold tracking-wide">Pending Review…</p>
            <p className="text-white/50 text-xs mt-1">Instagram Reel</p>
          </div>
        </div>

        {/* Instagram-style bottom bar */}
        <div className="absolute bottom-0 left-0 right-0 z-30 p-4 bg-gradient-to-t from-black/70 to-transparent">
          <div className="w-20 h-1.5 bg-white/20 rounded-full mb-1" />
          <div className="w-14 h-1 bg-white/10 rounded-full" />
        </div>
      </div>
    </div>
  );
}

function ProgressTracker() {
  return (
    <div className="w-full max-w-sm mx-auto">
      <div className="relative flex flex-col gap-0">
        {steps.map((step, i) => {
          const isDone = step.state === "done";
          const isActive = step.state === "active";
          const isLast = i === steps.length - 1;

          return (
            <div key={step.label} className="flex items-start gap-4">
              {/* Left: icon + connector */}
              <div className="flex flex-col items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center border-2 shrink-0 transition-all ${
                    isDone
                      ? "bg-green-500 border-green-500"
                      : isActive
                      ? "bg-yellow-400/20 border-yellow-400"
                      : "bg-neutral-800 border-neutral-700"
                  }`}
                >
                  {isDone ? (
                    <CheckCircle className="w-4 h-4 text-white" />
                  ) : isActive ? (
                    <motion.div
                      className="w-2.5 h-2.5 rounded-full bg-yellow-400"
                      animate={{ opacity: [1, 0.3, 1] }}
                      transition={{ duration: 1.2, repeat: Infinity }}
                    />
                  ) : (
                    <span className="text-xs">{step.icon || ""}</span>
                  )}
                </div>
                {!isLast && (
                  <div className={`w-0.5 h-8 mt-0.5 ${isDone ? "bg-green-500/50" : "bg-neutral-700"}`} />
                )}
              </div>

              {/* Right: label */}
              <div className={`pt-1 pb-8 ${isLast ? "pb-0" : ""}`}>
                <p
                  className={`text-sm font-medium ${
                    isDone ? "text-green-400" : isActive ? "text-yellow-300" : "text-neutral-500"
                  }`}
                >
                  {step.label}
                </p>
                {isActive && (
                  <p className="text-xs text-neutral-500 mt-0.5">Currently in progress</p>
                )}
                {step.state === "locked" && (
                  <p className="text-xs text-neutral-600 mt-0.5">Unlocks after approval</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CreatorSubmissionPending() {
  return (
    <div className="min-h-screen bg-neutral-950 text-white relative overflow-hidden">
      {/* Ambient background */}
      <div className="absolute inset-0 pointer-events-none">
        <motion.div
          className="absolute top-0 left-1/4 w-96 h-96 rounded-full blur-[120px]"
          style={{ background: "rgba(99,102,241,0.12)" }}
          animate={{ x: [0, 30, 0], y: [0, 20, 0] }}
          transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute bottom-0 right-1/4 w-80 h-80 rounded-full blur-[100px]"
          style={{ background: "rgba(168,85,247,0.10)" }}
          animate={{ x: [0, -20, 0], y: [0, -30, 0] }}
          transition={{ duration: 10, repeat: Infinity, ease: "easeInOut", delay: 2 }}
        />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-white/10 px-6 py-5">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <span className="text-sm font-semibold tracking-[0.2em] text-white">C O N T Y N T</span>
          <span className="text-xs text-neutral-500 bg-yellow-400/10 text-yellow-400 border border-yellow-400/20 px-2.5 py-1 rounded-full">
            Under Review
          </span>
        </div>
      </header>

      <main className="relative z-10 max-w-lg mx-auto px-6 py-10 flex flex-col gap-10">
        {/* Title */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center"
        >
          <h1 className="text-3xl font-semibold mb-2">Submission Received</h1>
          <p className="text-neutral-400 text-base">Your reel is now under review.</p>
        </motion.div>

        {/* Reel preview */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, delay: 0.15 }}
        >
          <ShimmerReel />
        </motion.div>

        {/* Progress tracker */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="bg-white/5 border border-white/10 rounded-2xl p-6"
        >
          <p className="text-xs font-semibold text-neutral-500 uppercase tracking-widest mb-5">Progress</p>
          <ProgressTracker />
        </motion.div>

        {/* Status message */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="flex items-start gap-3 bg-indigo-500/10 border border-indigo-500/20 rounded-2xl px-5 py-4"
        >
          <div className="w-2 h-2 rounded-full bg-indigo-400 mt-1 shrink-0" />
          <p className="text-sm text-indigo-200 leading-relaxed">
            {"We're verifying your submission. Once approved, your payout will be unlocked."}
          </p>
        </motion.div>

        {/* Cash out section */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="bg-white/5 border border-white/10 rounded-2xl p-6"
        >
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm font-semibold text-neutral-300">Cash Out</p>
            <span className="flex items-center gap-1.5 text-xs text-neutral-500">
              <Lock className="w-3.5 h-3.5" />
              Locked
            </span>
          </div>

          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-neutral-800 border border-white/5 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-neutral-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-neutral-600">—</p>
              <p className="text-xs text-neutral-600">Payout pending</p>
            </div>
          </div>

          <button
            disabled
            className="w-full py-3.5 rounded-xl bg-neutral-800 text-neutral-500 text-sm font-medium flex items-center justify-center gap-2 cursor-not-allowed border border-white/5"
          >
            <Lock className="w-4 h-4" />
            Cash Out
          </button>
          <p className="text-xs text-neutral-600 text-center mt-3">Available after approval</p>
        </motion.div>

        <p className="text-xs text-neutral-700 text-center pb-4">
          Questions? Reach out to the CONTYNT team.
        </p>
      </main>
    </div>
  );
}
