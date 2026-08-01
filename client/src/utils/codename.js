/**
 * codename.js — Generate a random two-word human-readable device name.
 * e.g. "Coral Salmon", "Swift Ember", "Jade Falcon"
 */

const ADJECTIVES = [
  'Amber', 'Arctic', 'Azure', 'Blaze', 'Bold', 'Bright', 'Brisk', 'Bronze',
  'Calm', 'Cedar', 'Cobalt', 'Cool', 'Coral', 'Crimson', 'Crystal', 'Cyan',
  'Dark', 'Dawn', 'Deep', 'Dusk', 'Electric', 'Ember', 'Emerald',
  'Fern', 'Fiery', 'Fleet', 'Flint', 'Frost', 'Frosty',
  'Ghost', 'Gilded', 'Glass', 'Gold', 'Golden', 'Grand', 'Granite',
  'Hazy', 'Ice', 'Icy', 'Indigo', 'Iron', 'Ivory',
  'Jade', 'Jasper', 'Keen', 'Lapis', 'Light', 'Luna', 'Lunar',
  'Magma', 'Maple', 'Mist', 'Misty', 'Mocha', 'Mossy',
  'Navy', 'Neon', 'Noble', 'Noir', 'Obsidian', 'Ocean', 'Olive', 'Onyx',
  'Opal', 'Orange', 'Pale', 'Pearl', 'Pine', 'Pink', 'Plum',
  'Quick', 'Quiet', 'Quartz', 'Rapid', 'Raven', 'Red', 'Rose', 'Royal',
  'Ruby', 'Russet', 'Rustic', 'Sage', 'Sand', 'Sandy', 'Sapphire',
  'Scarlet', 'Shadow', 'Sharp', 'Sierra', 'Silver', 'Slate', 'Sleek',
  'Smoky', 'Solar', 'Stark', 'Stealth', 'Steel', 'Stone', 'Storm',
  'Swift', 'Teal', 'Timber', 'Topaz', 'Twilight',
  'Ultra', 'Umber', 'Velvet', 'Vivid', 'Wild', 'Winter', 'Wisp', 'Zinc',
];

const NOUNS = [
  'Albatross', 'Anchor', 'Arrow', 'Aspen', 'Badger', 'Bison', 'Blizzard',
  'Brook', 'Buck', 'Canary', 'Canyon', 'Cedar', 'Cliff', 'Cloud',
  'Cobra', 'Comet', 'Condor', 'Coyote', 'Crane', 'Creek', 'Crest',
  'Crow', 'Current', 'Dagger', 'Dawn', 'Delta', 'Drift',
  'Eagle', 'Echo', 'Falcon', 'Fawn', 'Finch', 'Flare', 'Flash',
  'Fox', 'Gale', 'Gear', 'Geyser', 'Glacier', 'Grove',
  'Hawk', 'Heron', 'Horizon', 'Ibex', 'Island', 'Jade', 'Jaguar',
  'Kestrel', 'Kingfisher', 'Lance', 'Lark', 'Lynx', 'Magpie',
  'Mantis', 'Maple', 'Marten', 'Mesa', 'Mink', 'Moose', 'Moth',
  'Narwhal', 'Nebula', 'Nighthawk', 'Nomad', 'Osprey', 'Otter',
  'Panther', 'Parcel', 'Peak', 'Pebble', 'Peregrine', 'Phoenix',
  'Pillar', 'Pine', 'Puma', 'Quasar', 'Rabbit', 'Raptor', 'Raven',
  'Reef', 'Ridge', 'Ripple', 'Robin', 'Rock', 'Sable', 'Salmon',
  'Sandpiper', 'Sparrow', 'Sphinx', 'Sprint', 'Stallion', 'Stingray',
  'Storm', 'Swallow', 'Swan', 'Thorn', 'Thunder', 'Tiger', 'Titan',
  'Torch', 'Totem', 'Trout', 'Viper', 'Vortex', 'Warden', 'Weasel',
  'Whirlwind', 'Wildcat', 'Wolf', 'Wren', 'Zephyr',
];

/**
 * Generate a random two-word codename like "Coral Salmon".
 * @returns {string}
 */
export function generateCodename() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj} ${noun}`;
}

/**
 * Get a stable codename stored in localStorage, or generate a new one.
 * @returns {string}
 */
export function getOrCreateCodename() {
  const stored = localStorage.getItem('whoosh:codename');
  if (stored) return stored;
  const name = generateCodename();
  localStorage.setItem('whoosh:codename', name);
  return name;
}
