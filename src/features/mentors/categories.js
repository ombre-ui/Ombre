import { Briefcase, Code2, Target, HeartPulse } from 'lucide-react'

// The finalized Ombre mentor hierarchy: Category -> Subcategory -> Mentor.
// Do not add, rename, or remove anything here without updating the Ombre
// product architecture doc first — this file is the single source of truth
// the rest of the Mentors feature reads from.
export const MENTOR_CATEGORIES = [
  {
    id: 'business',
    name: 'Business',
    icon: Briefcase,
    description: 'Guidance for building and running a company — from validating an idea to hiring and marketing.',
    subcategories: [
      {
        id: 'startup',
        name: 'Startup',
        mentors: [
          {
            id: 'startup-validator',
            name: 'Startup Validator',
            description:
              'Before you spend another week building, find out if the idea holds up. This mentor pressure-tests your assumptions about the problem, the customer, and the market — the same questions a sharp early investor would ask. It looks for the gap between what you believe and what you can actually prove. You\u2019ll leave with a clear list of what\u2019s validated, what\u2019s assumed, and what to test next. Built for the moment right before you commit real time or money.',
          },
          {
            id: 'business-model-mentor',
            name: 'Business Model Mentor',
            description:
              'A good idea and a good business are not the same thing. This mentor works through how the business actually makes money — pricing, unit economics, what it costs to acquire a customer versus what that customer is worth. It\u2019s built to catch the model that looks fine on a slide but breaks at scale. Bring a rough plan or just a direction, and leave with the assumptions spelled out plainly. Useful whenever the question shifts from \u201cdoes anyone want this\u201d to \u201ccan this sustain itself.\u201d',
          },
        ],
      },
      {
        id: 'marketing',
        name: 'Marketing',
        mentors: [
          {
            id: 'marketing-strategist',
            name: 'Marketing Strategist',
            description:
              'Most marketing advice is generic because most products are treated as generic. This mentor starts from your specific positioning — who you\u2019re for, who you\u2019re not for, and what makes the difference worth talking about. It helps turn that into a message, a channel, and a first move, rather than a long list of tactics. Good for the moment you know what you\u2019ve built but not yet how to talk about it. The goal is one sharp angle, not ten mediocre ones.',
          },
        ],
      },
      {
        id: 'hiring',
        name: 'Hiring',
        mentors: [
          {
            id: 'team-hiring-advisor',
            name: 'Team & Hiring Advisor',
            description:
              'Hiring too early, or hiring the wrong first person, is expensive in ways that don\u2019t show up until later. This mentor helps you think through who you actually need right now, what the role really requires, and how to evaluate someone before the offer goes out. It\u2019s equally useful for structuring a small team so responsibilities don\u2019t quietly overlap or fall through. Bring a specific hire or team question, not just \u201chow do I build a team.\u201d Built for founders making people decisions without a People team yet.',
          },
        ],
      },
    ],
  },
  {
    id: 'coding',
    name: 'Coding',
    icon: Code2,
    description: 'Specialized support across the software lifecycle — from debugging to systems architecture.',
    subcategories: [
      {
        id: 'engineering',
        name: 'Engineering',
        mentors: [
          {
            id: 'engineering-architect',
            name: 'Engineering Architect',
            description:
              'Some decisions are cheap to change later, and some quietly become permanent. This mentor helps you tell the difference before you commit to a data model, a service boundary, or a framework choice. It reasons about tradeoffs the way a senior engineer would in a design review — cost now versus cost later, not just what\u2019s trendy. Bring a real decision you\u2019re stuck on, not an abstract question. Best used before the architecture hardens, not after.',
          },
          {
            id: 'flow-weaver',
            name: 'Flow Weaver',
            description:
              'The hardest bugs and the slowest features often come from how systems connect, not from any single piece of code. This mentor focuses on the flow of data and control between parts of your application — where state lives, what calls what, and where things get tangled. It\u2019s suited to untangling a system that\u2019s grown past its original design. Come with a specific flow that feels fragile or confusing. The output is a clearer map, not just a patch.',
          },
        ],
      },
      {
        id: 'debugger',
        name: 'Debugger',
        mentors: [
          {
            id: 'bug-hunter',
            name: 'Bug Hunter',
            description:
              'A bug report and the actual cause are usually two different things. This mentor works backward from symptoms to root cause, the way a methodical engineer traces a fault rather than guessing at fixes. It asks for reproduction steps, recent changes, and what\u2019s actually failing versus what merely looks broken. Good for the bug that\u2019s resisted your first three attempts. It won\u2019t just hand you a patch — it\u2019ll help you understand why the patch works.',
          },
        ],
      },
      {
        id: 'systems-automation',
        name: 'Systems & Automation',
        mentors: [
          {
            id: 'systems-engineer',
            name: 'Systems Engineer',
            description:
              'Some work should never require a human to remember to do it. This mentor helps design the automation, pipelines, and infrastructure that make a system reliable without constant attention — deploys, monitoring, the boring parts that matter most when they fail. It thinks in terms of what breaks at 3am and how to prevent it. Bring a manual process you\u2019re tired of babysitting. The focus is durability, not novelty.',
          },
        ],
      },
    ],
  },
  {
    id: 'productivity',
    name: 'Productivity',
    icon: Target,
    description: 'Mentors focused on attention, execution, and staying in motion on what matters.',
    subcategories: [
      {
        id: 'focus',
        name: 'Focus',
        mentors: [
          {
            id: 'attention-optimizer',
            name: 'Attention Optimizer',
            description:
              'Most focus advice assumes the problem is willpower. Often it\u2019s actually environment, task design, or an unclear next step. This mentor helps diagnose why attention keeps slipping on a specific piece of work, rather than offering generic focus tips you\u2019ve already heard. It\u2019s built for one real task at a time, not a philosophy of productivity. Bring the thing you\u2019re avoiding — the goal is removing friction, not adding discipline.',
          },
        ],
      },
      {
        id: 'planning',
        name: 'Planning',
        mentors: [
          {
            id: 'planning-architect',
            name: 'Planning Architect',
            description:
              'A plan that looks complete on paper often has no real order of operations underneath it. This mentor helps break a goal into a sequence that actually works — what has to happen first, what can wait, and where the real bottleneck is hiding. It\u2019s less concerned with covering every detail and more concerned with getting the order right. Bring a goal that feels overwhelming in its current shape. You\u2019ll leave with a shorter list than you expected.',
          },
          {
            id: 'execution-auditor',
            name: 'Execution Auditor',
            description:
              'Plans fail quietly, usually before anyone notices. This mentor looks at what you said you\u2019d do against what\u2019s actually gotten done, and asks the uncomfortable question of why the gap exists. It\u2019s not about motivation — it\u2019s about finding the specific point where a plan stalls out. Bring a project that\u2019s behind schedule or has stalled. The review is honest, not encouraging for its own sake.',
          },
        ],
      },
      {
        id: 'momentum',
        name: 'Momentum',
        mentors: [
          {
            id: 'momentum-specialist',
            name: 'Momentum Specialist',
            description:
              'Starting is often the hardest part, and most advice about it is vague. This mentor helps find the smallest real action that gets a stalled project moving again — not a pep talk, an actual next step sized correctly. It pays attention to why something stalled in the first place, since that shapes what will actually restart it. Good for the project you keep meaning to return to. The aim is one honest step, not a burst of motivation that fades by tomorrow.',
          },
        ],
      },
    ],
  },
  {
    id: 'health',
    name: 'Health',
    icon: HeartPulse,
    description: 'Guidance for pacing, movement, and recovery.',
    subcategories: [
      {
        id: 'fitness',
        name: 'Fitness',
        mentors: [
          {
            id: 'cadence-architect',
            name: 'Cadence Architect',
            description:
              'Most training plans fail because they ignore the life around them. This mentor builds a training rhythm around your actual schedule, recovery capacity, and history — not a generic template borrowed from someone else\u2019s life. It reasons about frequency and intensity the way a coach would, adjusting for what\u2019s sustainable rather than what\u2019s ideal in theory. Bring your current routine and constraints. The plan that gets followed beats the plan that looks best on paper.',
          },
          {
            id: 'movement-builder',
            name: 'Movement Builder',
            description:
              'Technique problems compound quietly until they become injuries or plateaus. This mentor works through movement patterns and exercise selection with attention to what your body can currently do, not just what a program prescribes. It\u2019s built for troubleshooting a specific lift, movement, or persistent discomfort. Bring the exact movement that feels off — the focus is the mechanism, not just \u201ctry this instead.\u201d',
          },
        ],
      },
      {
        id: 'habits',
        name: 'Habits',
        mentors: [
          {
            id: 'rhythm-architect',
            name: 'Rhythm Architect',
            description:
              'Habits that survive a bad week are built differently than habits that only work when life is easy. This mentor helps design routines around your actual constraints and failure points, not an idealized version of your day. It pays particular attention to the moments a habit usually breaks down, since that\u2019s where most systems quietly fail. Bring a habit you\u2019ve tried and dropped before. The goal is something that bends without breaking.',
          },
        ],
      },
      {
        id: 'recovery',
        name: 'Recovery',
        mentors: [
          {
            id: 'regen-optimizer',
            name: 'Regen Optimizer',
            description:
              'Progress usually stalls from under-recovery long before it stalls from under-effort. This mentor looks at sleep, load, and recovery patterns together, the way a coach reviews training logs for early warning signs. It\u2019s built to catch the slow buildup of fatigue before it becomes a setback. Bring your recent training or workload and how you\u2019ve been feeling. The recommendation is usually simpler, and less dramatic, than expected.',
          },
        ],
      },
    ],
  },
]

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
