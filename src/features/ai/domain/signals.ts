import type { MessagePriority } from '../../dtn/domain/types';
import { normalizeText } from './features';

/** Curated cues complement the small learned model. They favor recall for
 * life-threatening wording, where missing an emergency costs more than a false
 * alarm. Entries are already normalized (see normalizeText). */
const CUES: Readonly<Record<Exclude<MessagePriority, 'normal'>, readonly string[]>> = {
  critical: [
    'bleeding', 'bleed', 'trapped', 'rubble', 'under the rubble', 'collapsed', 'not breathing',
    'can t breathe', 'cant breathe', 'unconscious', 'passed out', 'fainted', 'heart attack', 'stroke',
    'seizure', 'on fire', 'fire', 'burning', 'shot', 'gunshot', 'stabbed', 'explosion', 'drowning',
    'dying', 'injured', 'wounded', 'choking', 'overdose', 'giving birth', 'gas leak', 'ambulance',
    'burns', 'burned', 'smoke', 'debris', 'shelling', 'airstrike', 'lost consciousness', 'chest pain',
    'not moving', 'not responding', 'crushed', 'pinned', 'electrocuted', 'shrapnel',
    'نزيف', 'ينزف', 'بنزف', 'تنزف', 'عالق', 'عالقين', 'عالقه', 'محاصر', 'محاصرين', 'تحت الركام',
    'تحت الانقاض', 'ركام', 'انقاض', 'انهار', 'انهيار', 'ما بتنفس', 'مش قادر اتنفس', 'لا يتنفس',
    'ما بيتنفس', 'اختناق', 'فاقد الوعي', 'مغمي عليه', 'اغمي', 'نوبه قلبيه', 'جلطه', 'تشنج', 'تشنجات',
    'حريق', 'انفجار', 'قصف', 'مصاب', 'مصابه', 'مصابين', 'اصابه', 'جريح', 'جرحي', 'طلق ناري', 'رصاص',
    'غرق', 'بيموت', 'بتموت', 'يموت', 'حروق', 'اسعاف', 'بتولد', 'ولاده', 'تسرب غاز',
    'دخان', 'فقد الوعي', 'مخنوق', 'انخنق', 'انطعن', 'ضيق نفس', 'ما بيتحرك', 'شظيه', 'شظايا',
    'انكهرب', 'غيبوبه', 'محشور', 'انحرق', 'عم تموت', 'عم يموت', 'غاره',
  ],
  high: [
    'water', 'food', 'medicine', 'medication', 'insulin', 'baby formula', 'diapers', 'shelter', 'tent',
    'evacuate', 'evacuation', 'missing', 'lost child', 'doctor', 'hospital', 'pregnant', 'elderly',
    'wheelchair', 'oxygen', 'dialysis', 'urgent', 'asap', 'hungry', 'blanket', 'blankets',
    'مي', 'ميه', 'ماء', 'مياه', 'اكل', 'طعام', 'دوا', 'دواء', 'ادويه', 'انسولين', 'حليب اطفال', 'حليب',
    'حفاضات', 'ماوي', 'خيمه', 'اخلاء', 'نزوح', 'مفقود', 'مفقوده', 'ضايع', 'ضايعه', 'دكتور', 'طبيب',
    'مستشفي', 'حامل', 'كبار السن', 'اكسجين', 'غسيل كلي', 'ضروري', 'مستعجل', 'عاجل', 'جوعانين',
    'جوع', 'بطانيات', 'حرامات',
  ],
  low: [
    'thanks', 'thank you', 'ok', 'okay', 'good morning', 'good night', 'lol', 'haha', 'how are you',
    'bye', 'see you', 'nice', 'cool',
    'شكرا', 'يسلمو', 'مشكور', 'تمام', 'ماشي', 'اوكي', 'صباح الخير', 'مساء الخير', 'تصبح علي خير',
    'هه', 'كيفك', 'شو اخبارك', 'مع السلامه', 'حبيبي', 'يعطيك العافيه',
  ],
};

// Arabic clitics attach to the following word: والنزيف، بالمستشفي، للاسعاف.
const ARABIC_PREFIXES = ['وال', 'بال', 'فال', 'كال', 'لل', 'ال', 'و', 'ف', 'ب', 'ل'];

export interface CueMatch {
  readonly priority: Exclude<MessagePriority, 'normal'>;
  readonly cue: string;
}

function variants(token: string): string[] {
  const forms = [token];
  for (const prefix of ARABIC_PREFIXES) {
    if (token.startsWith(prefix) && token.length - prefix.length >= 2) forms.push(token.slice(prefix.length));
  }
  return forms;
}

/** Whole-word cue matching after the same normalization as the model. */
export function matchCues(text: string): CueMatch[] {
  const normalized = normalizeText(text);
  if (normalized === '') return [];
  const tokens = normalized.split(' ');
  const words = new Set(tokens.flatMap(variants));
  const padded = ` ${normalized} `;
  const matches: CueMatch[] = [];
  for (const priority of ['critical', 'high', 'low'] as const) {
    for (const cue of CUES[priority]) {
      const found = cue.includes(' ')
        ? padded.includes(` ${cue} `)
        : words.has(cue);
      if (found) matches.push({ priority, cue });
    }
  }
  return matches;
}
