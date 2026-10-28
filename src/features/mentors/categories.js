import { Briefcase, Code2, Target, HeartPulse } from 'lucide-react'
import { MENTOR_CATALOG } from './catalogData.js'

// The finalized Ombre mentor hierarchy: Category -> Subcategory -> Mentor.
// The data (ids, names, descriptions) lives in ./catalogData.js, which has no React/icon imports so the
// API can validate mentor ids against it. This file only attaches the category icons for the UI.
// Do not add, rename, or remove anything without updating the Ombre product architecture doc first.
const CATEGORY_ICONS = {
  business: Briefcase,
  coding: Code2,
  productivity: Target,
  health: HeartPulse,
}

export const MENTOR_CATEGORIES = MENTOR_CATALOG.map((category) => ({
  id: category.id,
  name: category.name,
  icon: CATEGORY_ICONS[category.id],
  description: category.description,
  subcategories: category.subcategories,
}))

export function getCategory(categoryId) {
  return MENTOR_CATEGORIES.find((c) => c.id === categoryId) ?? null
}

export function getSubcategory(categoryId, subcategoryId) {
  const category = getCategory(categoryId)
  if (!category) return null
  const subcategory = category.subcategories.find((s) => s.id === subcategoryId) ?? null
  return subcategory ? { category, subcategory } : null
}

/** Direct 3-id lookup, used by the mentor profile route. */
export function getMentor(categoryId, subcategoryId, mentorId) {
  const found = getSubcategory(categoryId, subcategoryId)
  if (!found) return null
  const mentor = found.subcategory.mentors.find((m) => m.id === mentorId) ?? null
  return mentor ? { category: found.category, subcategory: found.subcategory, mentor } : null
}

/**
 * Reverse lookup by mentor id alone — used where only a mentorId is on hand
 * (e.g. a Conversation created from a mentor profile), so General AI can
 * show which mentor/category/subcategory a conversation belongs to without
 * that conversation needing to store the whole path.
 */
export function getMentorWithPath(mentorId) {
  for (const category of MENTOR_CATEGORIES) {
    for (const subcategory of category.subcategories) {
      const mentor = subcategory.mentors.find((m) => m.id === mentorId)
      if (mentor) return { category, subcategory, mentor }
    }
  }
  return null
}
