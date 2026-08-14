import { MapPin, DollarSign, Video } from "lucide-react";
import { motion } from "motion/react";

const features = [
  {
    id: 1,
    business: "Artisan Coffee Co.",
    location: "San Francisco, CA",
    payout: "$15–$30",
    platform: "Instagram Reels",
    description: "Capture the latte art experience and cozy ambiance of our downtown location.",
    tag: "Coffee & Café",
  },
  {
    id: 2,
    business: "Vista Fitness Studio",
    location: "Los Angeles, CA",
    payout: "$20–$40",
    platform: "Instagram Reels",
    description: "Showcase our morning yoga class and rooftop workout space with city views.",
    tag: "Fitness & Wellness",
  },
  {
    id: 3,
    business: "The Modern Bistro",
    location: "New York City, NY",
    payout: "$25–$50",
    platform: "Instagram Reels",
    description: "Feature our signature dishes and vibrant dinner service atmosphere.",
    tag: "Restaurant",
  },
];

export function Features() {
  return (
    <section id="features" className="bg-neutral-50 py-16 md:py-32">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12 md:mb-20"
        >
          <h2 className="text-3xl md:text-5xl mb-4 text-neutral-900" style={{ fontWeight: 600, lineHeight: 1.2 }}>
            Preview of Available Features
          </h2>
          <p className="text-base md:text-lg text-neutral-500 max-w-2xl mx-auto" style={{ fontWeight: 400 }}>
            See how Features appear on Contynt
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {features.map((feature, index) => (
            <motion.div
              key={feature.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: index * 0.1 }}
              className="group bg-white rounded-xl border border-neutral-200 hover:border-neutral-300 overflow-hidden transition-all duration-300 hover:shadow-xl"
            >
              <div className="p-8">
                {/* Tag and Example Badge */}
                <div className="flex items-center justify-between mb-4">
                  <div className="inline-flex items-center px-3 py-1 rounded-full bg-neutral-100 text-neutral-600 text-xs" style={{ fontWeight: 500 }}>
                    {feature.tag}
                  </div>
                  <div className="inline-flex items-center px-3 py-1 rounded-full bg-neutral-100 text-neutral-400 text-xs" style={{ fontWeight: 400 }}>
                    Example
                  </div>
                </div>

                {/* Business Name */}
                <h3 className="text-xl mb-3 text-neutral-900" style={{ fontWeight: 600 }}>
                  {feature.business}
                </h3>

                {/* Description */}
                <p className="text-neutral-600 mb-6 leading-relaxed" style={{ fontWeight: 400 }}>
                  {feature.description}
                </p>

                {/* Meta Info */}
                <div className="space-y-3 mb-6">
                  <div className="flex items-center gap-2 text-sm text-neutral-600">
                    <MapPin className="w-4 h-4 text-neutral-400" />
                    <span>{feature.location}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-neutral-600">
                    <DollarSign className="w-4 h-4 text-neutral-400" />
                    <span className="text-neutral-900" style={{ fontWeight: 600 }}>{feature.payout}</span>
                    <span>per post</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-neutral-600">
                    <Video className="w-4 h-4 text-neutral-400" />
                    <span>{feature.platform}</span>
                  </div>
                </div>

                {/* CTA */}
                <button className="w-full px-6 py-3 bg-neutral-400 text-white rounded-lg hover:bg-neutral-500 transition-all duration-200 group-hover:shadow-lg" style={{ fontWeight: 500 }}>
                  Claim Feature
                </button>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
