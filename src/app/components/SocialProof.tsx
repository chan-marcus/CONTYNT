import { motion } from "motion/react";

export function SocialProof() {
  return (
    <section className="bg-white border-b border-neutral-200">
      <div className="max-w-7xl mx-auto px-6 lg:px-8 py-8">
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="flex items-center justify-center"
        >
          <p className="text-xs md:text-sm text-neutral-500 tracking-wide text-center" style={{ fontWeight: 400 }}>
            Creators in <span className="text-neutral-900" style={{ fontWeight: 500 }}>San Francisco</span> • <span className="text-neutral-900" style={{ fontWeight: 500 }}>Los Angeles</span> • <span className="text-neutral-900" style={{ fontWeight: 500 }}>New York City</span> • <span className="whitespace-nowrap">Early Access Open</span>
          </p>
        </motion.div>
      </div>
    </section>
  );
}
