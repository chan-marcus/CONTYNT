import { Check } from "lucide-react";
import { motion } from "motion/react";

const benefits = [
  "No follower minimum required",
  "Paid per post",
  "Real-world content opportunities",
  "Build your portfolio fast",
];

export function ValueSection() {
  return (
    <section className="bg-white py-16 md:py-32">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="max-w-4xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="text-center mb-12 md:mb-16"
          >
            <h2 className="text-3xl md:text-5xl mb-4 text-neutral-900" style={{ fontWeight: 600, lineHeight: 1.2 }}>
              Built for Creators
            </h2>
            <p className="text-base md:text-lg text-neutral-500 max-w-2xl mx-auto" style={{ fontWeight: 400 }}>
              Everything you need to monetize your creativity on your own terms
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="grid grid-cols-1 md:grid-cols-2 gap-6"
          >
            {benefits.map((benefit, index) => (
              <div key={index} className="flex items-start gap-3 md:gap-4 p-4 md:p-6 rounded-xl bg-neutral-50 border border-neutral-100">
                <div className="flex-shrink-0 w-5 h-5 md:w-6 md:h-6 rounded-full bg-blue-500 flex items-center justify-center mt-0.5 md:mt-1">
                  <Check className="w-3 h-3 md:w-4 md:h-4 text-white" strokeWidth={3} />
                </div>
                <p className="text-base md:text-lg text-neutral-900" style={{ fontWeight: 500 }}>
                  {benefit}
                </p>
              </div>
            ))}
          </motion.div>
        </div>
      </div>
    </section>
  );
}
