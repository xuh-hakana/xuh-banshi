// 游戏数据：定价沿用《星露谷物语》基准（普通品质），部分名称本地化
export const SEASONS = [
  { name: '春', icon: '🌱', sky: '#8ecdf0' },
  { name: '夏', icon: '☀', sky: '#79c8ee' },
  { name: '秋', icon: '🍂', sky: '#9dc4e0' },
  { name: '冬', icon: '❄', sky: '#b9d7e8' }
];

export const WEATHERS = ['晴', '雨'];

// crop: {seed, days, seasons, sell, shape, color, accent, regrow}
export const CROPS = {
  parsnip:    { name:'防风草',   seed:'parsnip_seed',  days:4,  seasons:[0],    sell:35,  shape:'root',   color:'#e9dcae', accent:'#6aa753' },
  potato:     { name:'土豆',     seed:'potato_seed',   days:6,  seasons:[0],    sell:80,  shape:'root',   color:'#c79a6b', accent:'#5c9b47', chance:0.25 },
  kale:       { name:'羽衣甘蓝', seed:'kale_seed',     days:6,  seasons:[0],    sell:110, shape:'leaf',   color:'#59a94b', accent:'#8ed06a' },
  cauliflower:{ name:'花椰菜',   seed:'cauliflower_seed',days:12,seasons:[0],  sell:175, shape:'floret', color:'#f4f1df', accent:'#77bb58' },
  strawberry: { name:'草莓',     seed:'strawberry_seed',days:8, seasons:[0],   sell:120, shape:'berry',  color:'#e2596a', accent:'#4e9a46', regrow:4 },
  garlic:     { name:'大蒜',     seed:'garlic_seed',   days:4,  seasons:[0],    sell:60,  shape:'root',   color:'#f2efe2', accent:'#78b765' },
  tomato:     { name:'番茄',     seed:'tomato_seed',   days:11, seasons:[1],    sell:60,  shape:'vine',   color:'#e04e42', accent:'#4e9a46', regrow:4 },
  blueberry:  { name:'蓝莓',     seed:'blueberry_seed',days:13, seasons:[1],    sell:50,  shape:'berry',  color:'#4a63b8', accent:'#3f8d4a', regrow:4, multi:3 },
  hotpepper:  { name:'辣椒',     seed:'hotpepper_seed',days:5,  seasons:[1],    sell:40,  shape:'pepper', color:'#d94638', accent:'#4b9a48', regrow:3 },
  melon:      { name:'甜瓜',     seed:'melon_seed',    days:12, seasons:[1],    sell:250, shape:'melon',  color:'#b9d768', accent:'#5d9e46' },
  poppy:      { name:'罂粟花',   seed:'poppy_seed',    days:7,  seasons:[1],    sell:140, shape:'flower', color:'#e0566a', accent:'#e8b64e' },
  sunflower:  { name:'向日葵',   seed:'sunflower_seed',days:8,  seasons:[1,2],  sell:80,  shape:'flower', color:'#f3bd39', accent:'#6b4b2a' },
  wheat:      { name:'小麦',     seed:'wheat_seed',    days:4,  seasons:[1,2],  sell:30,  shape:'grain',  color:'#e5c65b', accent:'#a5ad4d' },
  pumpkin:    { name:'南瓜',     seed:'pumpkin_seed',  days:13, seasons:[2],    sell:320, shape:'melon',  color:'#e08a30', accent:'#4f9342' },
  cranberry:  { name:'蔓越莓',   seed:'cranberry_seed',days:7,  seasons:[2],    sell:75,  shape:'berry',  color:'#c83047', accent:'#3f8b45', regrow:5, multi:2 },
  eggplant:   { name:'茄子',     seed:'eggplant_seed',days:5,   seasons:[2],    sell:60,  shape:'pepper', color:'#8b4ca0', accent:'#579748', regrow:5 },
  bokchoy:    { name:'白菜',     seed:'bokchoy_seed',  days:4,  seasons:[2],    sell:80,  shape:'leaf',   color:'#8fc95f', accent:'#e5eab0' },
  yam:        { name:'山药',     seed:'yam_seed',      days:5,  seasons:[2],    sell:160, shape:'root',   color:'#c9a06b', accent:'#6ba152' },
  amaranth:   { name:'苋菜',     seed:'amaranth_seed', days:7,  seasons:[2],    sell:150, shape:'flower', color:'#c4446e', accent:'#6a9b48' },
  powdermelon:{ name:'冬甜瓜',   seed:'powdermelon_seed',days:7,seasons:[3],   sell:180, shape:'melon',  color:'#dbeaf2', accent:'#86b8c8' }
};

export const SEED_PRICES = {
  parsnip_seed:20, potato_seed:50, kale_seed:70, cauliflower_seed:80, strawberry_seed:100, garlic_seed:40,
  tomato_seed:60, blueberry_seed:80, hotpepper_seed:40, melon_seed:80, poppy_seed:100, sunflower_seed:200, wheat_seed:10,
  pumpkin_seed:100, cranberry_seed:240, eggplant_seed:20, bokchoy_seed:50, yam_seed:60, amaranth_seed:40, powdermelon_seed:100
};

// fish: {name, sell, seasons, diff(0~1}, color, time:'day'|'any'|'night'}
export const FISH = [
  { id:'carp',      name:'鲤鱼',     sell:60,  seasons:[0,1,2,3], diff:.30, color:'#9a7959' },
  { id:'sardine',   name:'沙丁鱼',   sell:40,  seasons:[0,1,2,3], diff:.25, color:'#93b4c7' },
  { id:'anchovy',   name:'凤尾鱼',   sell:30,  seasons:[0,2],     diff:.28, color:'#7f9fb4' },
  { id:'sunfish',   name:'太阳鱼',   sell:30,  seasons:[0,1,2],   diff:.32, color:'#6b9d70', time:'day' },
  { id:'trout',     name:'鳟鱼',     sell:65,  seasons:[0,2,3],   diff:.38, color:'#8c6e8e' },
  { id:'salmon',    name:'鲑鱼',     sell:75,  seasons:[2],       diff:.45, color:'#d88162' },
  { id:'catfish',   name:'鲶鱼',     sell:200, seasons:[0,2],     diff:.65, color:'#6e6552', weather:'rain' },
  { id:'tuna',      name:'金枪鱼',   sell:100, seasons:[1,2],     diff:.55, color:'#4d7fa7' },
  { id:'pufferfish',name:'河豚',     sell:200, seasons:[1],       diff:.75, color:'#e2c465', time:'day' },
  { id:'sturgeon',  name:'鲟鱼',     sell:200, seasons:[2,3],     diff:.70, color:'#6c7c88' },
  { id:'eel',       name:'鳗鱼',     sell:85,  seasons:[0,2],     diff:.55, color:'#6a6b4e', time:'night' },
  { id:'octopus',   name:'章鱼',     sell:150, seasons:[1],       diff:.72, color:'#b26a84' },
  { id:'squid',     name:'鱿鱼',     sell:80,  seasons:[3],       diff:.50, color:'#c4a2b5', time:'night' },
  { id:'perch',     name:'鲈鱼',     sell:55,  seasons:[3],       diff:.40, color:'#8e9a80' },
  { id:'shark',     name:'鲨鱼',     sell:250, seasons:[1],       diff:.85, color:'#5b7486' },
  { id:'goldfish',  name:'金鱼',     sell:30,  seasons:[0,1,2,3], diff:.35, color:'#e8964f' }
];

export const FORAGE = [
  { id:'horseradish', name:'野生辣根', sell:20, seasons:[0], color:'#ece7c9', shape:'root' },
  { id:'daffodil',    name:'水仙花',   sell:30, seasons:[0], color:'#f2d85d', shape:'flower' },
  { id:'leek',        name:'韭葱',     sell:20, seasons:[0], color:'#a9cf7d', shape:'leaf' },
  { id:'springonion', name:'春葱',     sell:25, seasons:[0], color:'#7fc06a', shape:'leaf' },
  { id:'commonmush',  name:'普通蘑菇', sell:40, seasons:[0,2,3], color:'#b47a56', shape:'mush' },
  { id:'spiceberry',  name:'香莓',     sell:80, seasons:[1], color:'#d8567a', shape:'berry' },
  { id:'sweetpea',    name:'香豌豆',   sell:50, seasons:[1], color:'#cba4d8', shape:'flower' },
  { id:'wildplum',    name:'野李子',   sell:40, seasons:[2], color:'#8d569c', shape:'berry' },
  { id:'hazelnut',    name:'榛子',     sell:40, seasons:[2], color:'#966b46', shape:'mush' },
  { id:'blackberry',  name:'黑莓',     sell:20, seasons:[2], color:'#663b5c', shape:'berry' },
  { id:'crocus',      name:'番红花',   sell:75, seasons:[3], color:'#b69ad4', shape:'flower' },
  { id:'snowyam',     name:'雪山药',   sell:100,seasons:[3], color:'#e6eef0', shape:'root' }
];

export const ORES = [
  { id:'stone',  name:'石头',   sell:2,   color:'#9a9a93' },
  { id:'coal',   name:'煤炭',   sell:15,  color:'#3c3b3a' },
  { id:'copper', name:'铜矿石', sell:25,  color:'#c47a4a' },
  { id:'iron',   name:'铁矿石', sell:50,  color:'#c6c3bb' },
  { id:'gold',   name:'金矿石', sell:250, color:'#e0bb42' },
  { id:'gem',    name:'宝石',   sell:400, color:'#8ad4e6' }
];

export const SIMPLE_ITEMS = {
  rice:       { name:'白饭',   sell:5,  buy:35,  kind:'food', energy:32, color:'#f7f5e8', desc:'本鲸的能量来源，也就是鱼片说的 Token。' },
  bait:       { name:'鱼饵',   sell:5,  buy:20,  kind:'toolitem', color:'#c8a47a', desc:'钓鱼时缩小绿区浮动幅度。' },
  wood:       { name:'木材',   sell:2,  color:'#a07445' },
  fiber:      { name:'纤维',   sell:1,  color:'#a6b16a' },
  jelly:      { name:'果酱',   sell:120, color:'#c85b7e' },
  smokedfish: { name:'熏鱼',   sell:160, color:'#d18a4e' },
  sprinkler:  { name:'洒水器', sell:500, color:'#68a9c4', kind:'machine' },
  jamjar:     { name:'果酱罐', sell:400, color:'#c78a9a', kind:'machine' },
  smoker:     { name:'熏鱼器', sell:600, color:'#8b7355', kind:'machine' }
};

export const TOOLS = {
  hoe:      { name:'锄头',     energy:4, desc:'翻垦农场里的草地，准备播种。' },
  can:      { name:'洒水壶',   energy:3, desc:'给耕地浇水；走到水边可自动装满。' },
  axe:      { name:'斧头',     energy:6, desc:'砍树获得木材。' },
  pick:     { name:'镐子',     energy:6, desc:'敲碎石头，挖到矿石。' },
  scythe:   { name:'镰刀',     energy:2, desc:'割草取纤维，也能收获作物。' },
  rod:      { name:'钓竿',     energy:5, desc:'在水边使用，开始钓鱼。' }
};

export const TOOL_UPGRADES = [
  { id:'copper', name:'铜制', cost:2000,  power:1, note:'更省体力' },
  { id:'steel',  name:'铁制', cost:5000,  power:2, note:'更省体力，钓鱼更容易' },
  { id:'gold',   name:'金制', cost:10000, power:3, note:'最省体力，钓鱼绿区更大' }
];

export const RECIPES = {
  sprinkler: { name:'洒水器', cost:{ copper:1, iron:1 },  desc:'每天早上自动浇灌上下左右四格。' },
  jamjar:    { name:'果酱罐', cost:{ wood:30, stone:20, coal:5 }, desc:'放入作物，第二天变成价值翻倍的果酱。' },
  smoker:    { name:'熏鱼器', cost:{ wood:25, stone:15, coal:5 }, desc:'放入鱼，第二天变成更值钱的熏鱼。' }
};

export const QUESTS = [
  { id:'q_ship',  name:'本鲸要吃饭',   desc:'通过出货箱卖出 5 个作物', goal:5,  reward:600,  track:'shipCrops' },
  { id:'q_fish',  name:'鱼塘扩建计划', desc:'钓到 3 条鱼',             goal:3,  reward:800,  track:'fish' },
  { id:'q_ore',   name:'挖矿小能手',   desc:'敲碎 10 块石头',          goal:10, reward:700,  track:'stone' },
  { id:'q_gold',  name:'攒白饭',       desc:'累计赚到 3000 金币',      goal:3000,reward:1000, track:'earned' },
  { id:'q_forage',name:'海边散步',     desc:'采集 6 个野生物',         goal:6,  reward:500,  track:'forage' }
];

export const SKILLS = {
  farming:  { name:'耕作', color:'#8fd07a' },
  fishing:  { name:'钓鱼', color:'#6fc8e8' },
  mining:   { name:'采矿', color:'#d0b078' },
  foraging: { name:'采集', color:'#d6a0c8' }
};
export const XP_NEEDED = lv => Math.round(100 * Math.pow(1.32, lv - 1));

export function itemName(id) {
  if (CROPS[id]) return CROPS[id].name;
  if (SEED_PRICES[id] !== undefined) return CROPS[Object.keys(CROPS).find(k => CROPS[k].seed === id)]?.name + '种子' || id;
  if (FISH.find(f => f.id === id)) return FISH.find(f => f.id === id).name;
  if (FORAGE.find(f => f.id === id)) return FORAGE.find(f => f.id === id).name;
  if (ORES.find(o => o.id === id)) return ORES.find(o => o.id === id).name;
  if (SIMPLE_ITEMS[id]) return SIMPLE_ITEMS[id].name;
  if (TOOLS[id]) return TOOLS[id].name;
  return id;
}

export function itemSell(id) {
  if (CROPS[id]) return CROPS[id].sell;
  const fish = FISH.find(f => f.id === id); if (fish) return fish.sell;
  const forage = FORAGE.find(f => f.id === id); if (forage) return forage.sell;
  const ore = ORES.find(o => o.id === id); if (ore) return ore.sell;
  if (SIMPLE_ITEMS[id]) return SIMPLE_ITEMS[id].sell ?? 0;
  return 0;
}

export function itemColor(id) {
  if (CROPS[id]) return CROPS[id].color;
  const fish = FISH.find(f => f.id === id); if (fish) return fish.color;
  const forage = FORAGE.find(f => f.id === id); if (forage) return forage.color;
  const ore = ORES.find(o => o.id === id); if (ore) return ore.color;
  if (SIMPLE_ITEMS[id]) return SIMPLE_ITEMS[id].color;
  if (SEED_PRICES[id] !== undefined) return '#9c7248';
  return '#888';
}

export function itemKind(id) {
  if (CROPS[id]) return 'crop';
  if (SEED_PRICES[id] !== undefined) return 'seed';
  if (FISH.find(f => f.id === id)) return 'fish';
  if (FORAGE.find(f => f.id === id)) return 'forage';
  if (ORES.find(o => o.id === id)) return 'ore';
  return SIMPLE_ITEMS[id]?.kind || 'item';
}
