import type { ChatScript } from '../../shared/types/dataset.ts';

/**
 * Answer templates for the MOCK agents. Edit these (or the copy saved in the dataset JSON)
 * to change how demo answers read. Placeholders are filled in src/mock/answers.ts.
 * Missing values are rendered as "no data", never as 0.
 */
export const CHAT_SCRIPTS: ChatScript[] = [
  {
    intent: 'overview',
    keywords: [],
    templates: [
      'Latest for {location}: PM2.5 {pm25} µg/m³ ({band}), {trend}, as of {time} local time.',
      'The highest-ranked item for {location} right now is: "{headline}" (status: {status}).',
    ],
    examplePrompts: [
      "What's the haze situation in Pekanbaru?",
      'Give me an overview of the worst places right now',
    ],
  },
  {
    intent: 'compare',
    keywords: [
      'compare',
      ' vs',
      'versus',
      'difference between',
      'better than',
      'worse than',
    ],
    templates: [
      '{location}: PM2.5 {pm25} µg/m³ ({band}). {locationB}: PM2.5 {pm25B} µg/m³ ({bandB}).',
      '{comparison}',
    ],
    examplePrompts: [
      'Compare Kuala Lumpur and Johor Bahru today',
      'Is Singapore better than Kuala Lumpur right now?',
    ],
  },
  {
    intent: 'forecast',
    keywords: [
      'forecast',
      'tomorrow',
      'tonight',
      'next',
      'later',
      'will it',
      'going to',
      'expected',
    ],
    templates: [
      'The forecast for {location} is {forecastDirection}, with PM2.5 around {forecastPm25} µg/m³ until {validTo}.',
      'Forecasts are model estimates, not measurements, so treat them as a guide.',
    ],
    examplePrompts: [
      'Will the haze in Kuching get worse tomorrow?',
      "What's the forecast for Pekanbaru?",
    ],
  },
  {
    intent: 'cause',
    keywords: [
      'why',
      'cause',
      'driving',
      'reason',
      'fire',
      'hotspot',
      'where is it coming from',
    ],
    templates: [
      'In {location}, haze is usually driven by {driver}.',
      'The latest fire report counts {hotspots} hotspots near {location} on {landType} land. A hotspot is a heat signal, not a confirmed fire.',
    ],
    examplePrompts: [
      "What's driving haze in Palembang?",
      'Why is Sibu so hazy this week?',
    ],
  },
  {
    intent: 'health',
    keywords: [
      'safe',
      'health',
      'run',
      'jog',
      'exercise',
      'mask',
      'children',
      'kids',
      'outdoor',
      'asthma',
      'school',
      'work outside',
    ],
    templates: [
      'Air quality in {location} is in the "{band}" band ({standardNote}).',
      'WorkerShield only points to official guidance: {guidanceSource}. This is not medical advice; follow your local health authority.',
    ],
    examplePrompts: [
      'Is it safe to run outside in Kuala Lumpur?',
      'Should kids play outdoors in Shah Alam today?',
    ],
  },
  {
    intent: 'sources',
    keywords: [
      'source',
      'evidence',
      'trust',
      'verify',
      'verified',
      'how do you know',
      'where does',
    ],
    templates: [
      'This answer uses {sourceCount} source(s): {sourceNames}.',
      'EvidenceCritic result: {checksSummary}.',
    ],
    examplePrompts: [
      'How do you know the Kuching reading is right?',
      'Which sources do you trust for Palembang?',
    ],
  },
  {
    intent: 'changes',
    keywords: [
      'new',
      'latest',
      'changed',
      'update',
      'today',
      'recent',
      'what happened',
    ],
    templates: [
      'There were {updates} updates in the last 6 hours{scopeNote}.',
      'Most recent: "{headline}" ({timeAgo}).',
    ],
    examplePrompts: [
      'What changed in the last few hours?',
      "What's new in Malaysia?",
    ],
  },
];
