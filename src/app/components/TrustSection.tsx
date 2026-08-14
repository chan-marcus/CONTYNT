import { Shield, Clock, CheckCircle } from "lucide-react";
import { motion } from "motion/react";

const trustFeatures = [
  {
    icon: Shield,
    title: "Verified Payouts",
    description: "Secure, on-time payments",
  },
  {
    icon: Clock,
    title: "48-Hour Minimum",
    description: "Keep content live for visibility period",
  },
  {
    icon: CheckCircle,
    title: "Transparent Approval",
    description: "Clear guidelines and fair review process",
  },
];

export function TrustSection() {
  return (
    <section className="bg-white py-16 md:py-32">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12 md:mb-16"
        >
          <h2 className="text-3xl md:text-5xl mb-4 text-neutral-900" style={{ fontWeight: 600, lineHeight: 1.2 }}>
            Trust & Safety
          </h2>
          <p className="text-base md:text-lg text-neutral-500 max-w-2xl mx-auto" style={{ fontWeight: 400 }}>
            Built on transparency and reliability
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {trustFeatures.map((feature, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: index * 0.1 }}
              className="text-center"
            >
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-white border border-neutral-200 mb-6">
                <feature.icon className="w-6 h-6 text-neutral-600" strokeWidth={1.5} />
              </div>
              <h3 className="text-lg mb-2 text-neutral-900" style={{ fontWeight: 600 }}>
                {feature.title}
              </h3>
              <p className="text-neutral-600" style={{ fontWeight: 400 }}>
                {feature.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
