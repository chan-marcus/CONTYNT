import { UserPlus, MapPin, Sparkles } from "lucide-react";
import { motion } from "motion/react";

const steps = [
  {
    number: "01",
    title: "Join CONTYNT",
    description: "Sign up with your Instagram. No follower minimum required.",
    icon: UserPlus,
  },
  {
    number: "02",
    title: "Claim a Feature",
    description: "Browse local businesses and claim feature opportunities near you.",
    icon: MapPin,
  },
  {
    number: "03",
    title: "Create & Get Paid",
    description: "Post your content, meet the requirements, and receive payment directly.",
    icon: Sparkles,
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="bg-white py-16 md:py-32">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12 md:mb-20"
        >
          <h2 className="text-3xl md:text-5xl mb-4 text-neutral-900" style={{ fontWeight: 600, lineHeight: 1.2 }}>
            How It Works
          </h2>
          <p className="text-base md:text-lg text-neutral-500 max-w-2xl mx-auto" style={{ fontWeight: 400 }}>
            Start earning from your content in three simple steps
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {steps.map((step, index) => (
            <motion.div
              key={step.number}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: index * 0.1 }}
              className="relative group"
            >
              <div className="p-6 md:p-10 rounded-xl border border-neutral-200 hover:border-neutral-300 transition-all duration-300 bg-white hover:shadow-lg h-full">
                {/* Icon */}
                <div className="w-10 h-10 md:w-12 md:h-12 rounded-lg bg-neutral-100 flex items-center justify-center mb-4 md:mb-6 group-hover:bg-blue-50 transition-colors">
                  <step.icon className="w-5 h-5 md:w-6 md:h-6 text-neutral-900 group-hover:text-blue-600 transition-colors" />
                </div>

                {/* Number */}
                <div className="text-xs md:text-sm text-neutral-400 mb-2 md:mb-3 tracking-wider" style={{ fontWeight: 500 }}>
                  STEP {step.number}
                </div>

                {/* Title */}
                <h3 className="text-xl md:text-2xl mb-3 md:mb-4 text-neutral-900" style={{ fontWeight: 600 }}>
                  {step.title}
                </h3>

                {/* Description */}
                <p className="text-sm md:text-base text-neutral-600 leading-relaxed" style={{ fontWeight: 400 }}>
                  {step.description}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}