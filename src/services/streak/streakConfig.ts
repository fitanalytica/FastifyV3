import { createHash } from 'node:crypto';

// The streak's content that the phone shows and does not compute (docs/data/sync.md section 4f): the levels of the journey and the texts of its notifications. The same for every user, so the phone sends the version
// it holds and gets it whole only when it changed (the version is a hash of the content, as the catalogue's is). Held in code for now; when it needs changing without a release it moves to a table and only this file changes.

/** One level of the journey: reached when the streak's valid days reach `duration` (protection days do not count), and on reaching it `reward` protection days are granted (none for the last). */
export interface StreakLevel { level_id: string; title: string; subtitle: string; reward: number | null; duration: number }
export interface StreakMessage { title: string; body: string }
/** `daily_target`: a nudge during the day; `streak_at_risk`: the evening one while still under the goal; `protection_used`: the morning after a protection day was spent. */
export type StreakMessages = Record<'daily_target' | 'streak_at_risk' | 'protection_used', StreakMessage[]>;
export interface StreakConfig { version: string; levels: StreakLevel[]; messages: StreakMessages }

const LEVELS: StreakLevel[] = [
  { level_id: '9129d0f8-54c9-4ba4-a61a-0ad9169d8077', title: 'Beginner', subtitle: '2 Days Challenge', reward: 2, duration: 2 },
  { level_id: '04de35bc-2808-4ba1-8289-33b22e2632e0', title: 'Contender', subtitle: '7 Days Challenge', reward: 2, duration: 7 },
  { level_id: 'd58b9a54-da5d-4b1e-8095-bc56c0219099', title: 'Achiever', subtitle: '21 Days Challenge', reward: 4, duration: 21 },
  { level_id: 'bdc2969a-8640-4d79-abb1-4541e9839011', title: 'Champion', subtitle: '60 Days Challenge', reward: 8, duration: 60 },
  { level_id: '986b0ab6-5b15-46c8-8c4a-cf47f56f3efd', title: 'Warrior', subtitle: '180 Days Challenge', reward: 15, duration: 180 },
  { level_id: '0c4066f3-2d1b-4cfb-8cee-4c4dce6d4dc4', title: 'Legend', subtitle: '365 Days Challenge', reward: 25, duration: 365 },
  { level_id: '447bebf3-2a7d-4b17-a7f3-f859249be2e0', title: 'Titan', subtitle: '500 Days Challenge', reward: 40, duration: 500 },
  { level_id: 'd0c5c34e-3bcb-48a3-a533-7221b68daafc', title: 'Immortal', subtitle: '1000 Days Challenge', reward: null, duration: 1000 },
];

const DAILY_TARGET: StreakMessage[] = [
  { title: 'Keep Your Streak Alive', body: 'Achieve 80% of your daily target today to keep your streak going. Otherwise, you\'ll use 1 protection day.' },
  { title: 'You\'re Almost There', body: 'Reach 80% of your goal today to protect your streak without using a protection day.' },
  { title: 'Don\'t Let Today Slip', body: 'Hit 80% of your target today. Miss it, and 1 protection day will be used.' },
  { title: 'Your Streak Needs You', body: 'A little more effort today keeps your streak alive. Aim for at least 80% of your goal.' },
  { title: 'One More Push', body: 'You\'re closer than you think. Reach 80% of your target to keep your streak safe.' },
  { title: 'Protect Your Progress', body: 'Complete 80% of today\'s goal to continue your streak without spending protection.' },
  { title: 'Stay Consistent', body: 'Consistency beats perfection. Reach 80% today and your streak stays intact.' },
  { title: 'Your Streak Is Counting On You', body: 'Finish 80% of today\'s goal before the day ends.' },
  { title: 'Almost There', body: 'A few more steps can save your streak. Reach 80% of today\'s target.' },
  { title: 'Finish Strong', body: 'Complete 80% of your daily goal and keep your streak moving forward.' },
  { title: 'Keep the Momentum', body: 'Don\'t stop now. Reach 80% today to protect your streak.' },
  { title: 'A Small Effort Matters', body: 'Today\'s 80% keeps tomorrow\'s streak alive.' },
  { title: 'Stay on Track', body: 'Reach 80% of your target today to avoid using a protection day.' },
  { title: 'Your Challenge Continues', body: 'Complete at least 80% of today\'s goal to stay in the game.' },
  { title: 'Every Step Counts', body: 'Just a little more gets you to 80% and keeps your streak safe.' },
  { title: 'Don\'t Waste a Protection', body: 'Reach today\'s 80% target and save your protection days for when you really need them.' },
  { title: 'Finish Today\'s Goal', body: 'Get to 80% before midnight to keep your streak going.' },
  { title: 'Keep Building', body: 'Every consistent day brings you closer to your next streak milestone. Reach 80% today.' },
  { title: 'Today\'s Goal Awaits', body: 'Hit 80% of your target and continue your streak with confidence.' },
  { title: 'You\'ve Got This', body: 'One final push today keeps your streak alive without using protection.' },
];

const STREAK_AT_RISK: StreakMessage[] = [
  { title: 'Streak at Risk', body: 'Your streak is in danger. Reach 80% of today\'s goal before it\'s too late.' },
  { title: 'Don\'t Break Your Streak', body: 'You still have time to save today\'s streak.' },
  { title: 'Time Is Running Out', body: 'Complete 80% of your target now to keep your streak alive.' },
  { title: 'Act Before Midnight', body: 'Your streak depends on today\'s progress.' },
  { title: 'Save Your Streak', body: 'You\'re running out of time. Reach today\'s minimum goal now.' },
  { title: 'Last Chance', body: 'A little more activity today can save your streak.' },
  { title: 'Keep It Going', body: 'Don\'t let all your hard work end today.' },
  { title: 'Almost Out of Time', body: 'Your streak needs your attention before the day ends.' },
  { title: 'Stay Consistent', body: 'Today\'s goal is the only thing standing between you and another streak day.' },
  { title: 'One More Walk', body: 'Take a quick walk and keep your streak alive.' },
  { title: 'Your Progress Matters', body: 'Don\'t let today become the day your streak ends.' },
  { title: 'Keep the Chain Going', body: 'One more effort today keeps your streak intact.' },
  { title: 'Don\'t Lose Your Momentum', body: 'Reach today\'s minimum target before the clock runs out.' },
  { title: 'Finish What You Started', body: 'Protect your streak with a little more movement today.' },
  { title: 'Every Minute Counts', body: 'There\'s still time to save today\'s streak.' },
  { title: 'Keep Your Record Alive', body: 'Your streak deserves one final push today.' },
  { title: 'Don\'t Give Up Now', body: 'Just enough activity can save your streak.' },
  { title: 'Save Today\'s Progress', body: 'You\'re close. Reach the minimum goal before midnight.' },
  { title: 'Your Streak Needs One More Push', body: 'Don\'t let today reset your progress.' },
  { title: 'It\'s Not Over Yet', body: 'Complete today\'s goal and continue your streak tomorrow.' },
];

const PROTECTION_USED: StreakMessage[] = [
  { title: 'Protection Used', body: '1 protection day was used yesterday to keep your streak alive.' },
  { title: 'Your Streak Was Saved', body: 'A protection day was automatically used yesterday.' },
  { title: 'Good News', body: 'Your streak continues thanks to 1 protection day.' },
  { title: 'Protection Activated', body: 'Yesterday\'s missed goal used 1 protection day to preserve your streak.' },
  { title: 'You\'re Still Going', body: 'Your streak survived yesterday using 1 protection day.' },
  { title: 'One Protection Used', body: 'Your streak is safe, but you now have one fewer protection day.' },
  { title: 'Back on Track Today', body: 'A protection day kept your streak alive yesterday. Let\'s avoid using another today.' },
  { title: 'Your Streak Lives On', body: 'Yesterday\'s protection saved your progress.' },
  { title: 'Protected Yesterday', body: '1 protection day was used. Keep moving today to preserve the rest.' },
  { title: 'A Safety Net Helped', body: 'Your streak was protected yesterday. Don\'t rely on it twice.' },
  { title: 'Protection Spent', body: 'One protection day has been used to continue your streak.' },
  { title: 'You\'re Still in the Challenge', body: 'A protection day kept you going yesterday.' },
  { title: 'Protection Saved the Day', body: 'Yesterday\'s missed target didn\'t end your streak.' },
  { title: 'Don\'t Waste Tomorrow', body: 'A protection day was used yesterday. Make today count.' },
  { title: 'Keep Moving Forward', body: 'Your streak is safe thanks to yesterday\'s protection.' },
  { title: 'Another Chance Today', body: 'Yesterday\'s protection kept your streak alive. Build on it today.' },
  { title: 'Your Backup Was Used', body: '1 protection day stepped in to save your streak yesterday.' },
  { title: 'Streak Preserved', body: 'Protection was used yesterday so your progress continues.' },
  { title: 'Still Going Strong', body: 'A protection day kept your streak alive. Let\'s earn today\'s streak naturally.' },
  { title: 'Make Today Count', body: 'Yesterday used 1 protection day. Reach today\'s goal and save the rest.' },
];

const content = { levels: LEVELS, messages: { daily_target: DAILY_TARGET, streak_at_risk: STREAK_AT_RISK, protection_used: PROTECTION_USED } };
const VERSION = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 12);

/** The streak's content with its version. The data does not change while the server runs, so it is built once. */
export const streakConfig = (): StreakConfig => ({ version: VERSION, ...content });
