import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";

export function BusinessCTA() {
  return (
    <section className="bg-neutral-50 py-16 md:py-32">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center max-w-3xl mx-auto"
        >
          <h2 className="text-3xl md:text-5xl mb-6 text-neutral-900" style={{ fontWeight: 600, lineHeight: 1.2 }}>
            For Businesses
          </h2>
          <p className="text-base md:text-lg text-neutral-600 mb-8" style={{ fontWeight: 400, lineHeight: 1.6 }}>
            Get authentic content from local creators who love your brand. Reach new audiences through trusted voices in your community.
          </p>
          <a
            href="#businesses"
            className="inline-flex items-center gap-2 px-8 py-4 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 transition-all duration-200 group"
            style={{ fontWeight: 500 }}
          >
            Get Started
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </a>
        </motion.div>
      </div>
    </section>
  );
}
