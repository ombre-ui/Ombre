import { Briefcase, Code2, Target, HeartPulse } from 'lucide-react'

// The four top-level Mentor categories from the Ombre product architecture.
// Do not add, rename, or remove categories here without updating that
// architecture doc — subcategories and the 16-mentor roster arrive in a
// later phase, under these same four categories.
export const MENTOR_CATEGORIES = [
  {
    id: 'business',
    name: 'Business',
    icon: Briefcase,
    description: 'Guidance for building and running a company — from validating an idea to hiring and marketing.',
  },
  {
    id: 'coding',
    name: 'Coding',
    icon: Code2,
    description: 'Specialized support across the software lifecycle — from debugging to systems architecture.',
  },
  {
    id: 'productivity',
    name: 'Productivity',
    icon: Target,
    description: 'Mentors focused on attention, execution, and staying in motion on what matters.',
  },
  {
    id: 'health',
    name: 'Health',
    icon: HeartPulse,
    description: 'Guidance for pacing, movement, and recovery.',
  },
]

export function getCategory(id) {
  return MENTOR_CATEGORIES.find((c) => c.id === id) ?? null
}
