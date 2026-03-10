---
lang: en
tags: [example, recipe, multilingual]
---

# Matcha Latte Recipe

> This note opens in English automatically because of `lang: en` in the frontmatter.
> It demonstrates **all four supported syntax styles** for lang blocks.

---

## Ingredients
*(uses default `:::li8n` style)*

:::li8n en
- 1 tsp ceremonial-grade matcha powder
- 2 tbsp hot water (80 °C / 175 °F — not boiling)
- 200 ml oat milk (or your preferred milk)
- 1 tsp honey or maple syrup (optional)
- Ice cubes (for iced version)
:::

:::li8n zh-CN
- 1 茶匙仪式级抹茶粉
- 2 汤匙热水（80 °C — 不要沸腾）
- 200 毫升燕麦奶（或你喜欢的牛奶）
- 1 茶匙蜂蜜或枫糖浆（可选）
- 冰块（冰饮版本使用）
:::

:::li8n ja
- 抹茶パウダー（儀式用）小さじ 1
- お湯 80 °C で大さじ 2（沸騰させないこと）
- オーツミルク（またはお好みのミルク）200 ml
- ハチミツまたはメープルシロップ 小さじ 1（お好みで）
- 氷（アイス版に使用）
:::

---

## Instructions
*(uses Hexo `{% li8n %}` style — visible markers)*

{% li8n en %}
1. Sift the matcha powder into a small bowl to remove lumps.
2. Add the hot water and whisk vigorously in a zigzag motion until frothy (~30 s). A bamboo chasen works best.
3. Heat the oat milk gently — do not boil. Froth if desired.
4. Pour the matcha over the milk.
5. Sweeten to taste and enjoy immediately.

**Iced version:** Pour matcha over a glass full of ice, then add cold oat milk.
{% endli8n %}

{% li8n zh-CN %}
1. 将抹茶粉过筛到小碗中，去除结块。
2. 加入热水，用茶筅或小打蛋器以锯齿状快速搅打约 30 秒，直至产生泡沫。
3. 轻轻加热燕麦奶，不要煮沸。如需奶泡，可使用打奶泡器。
4. 将抹茶倒入牛奶中。
5. 按口味加糖，立即享用。

**冰饮版本：** 将抹茶倒在装满冰块的杯子上，然后加入冷燕麦奶。
{% endli8n %}

{% li8n ja %}
1. 抹茶パウダーをふるいにかけて小さなボウルに入れ、ダマをなくします。
2. お湯を加え、茶筅でジグザグに素早く約 30 秒間泡立てます。
3. オーツミルクを優しく温めます（沸騰させないこと）。お好みでフォームを作ります。
4. 抹茶をミルクに注ぎます。
5. 甘さはお好みで調整し、すぐにお召し上がりください。

**アイス版：** 氷を入れたグラスに抹茶を注ぎ、冷たいオーツミルクを加えます。
{% endli8n %}

---

## Storage Tips
*(uses Markdown comment `[//]: # (lang …)` style — markers are invisible in reading mode)*

[//]: # (li8n en)
Store unused matcha in an airtight container away from light, heat, and moisture. Consume within 2–3 months of opening for best flavour.
[//]: # (endli8n)

[//]: # (li8n zh-CN)
将未使用的抹茶存放在密封容器中，避免光线、热量和潮湿。开封后 2–3 个月内使用效果最佳。
[//]: # (endli8n)

[//]: # (li8n ja)
使用しない抹茶は密閉容器に入れ、光・熱・湿気を避けて保管してください。開封後 2〜3 か月以内にお使いください。
[//]: # (endli8n)

---

## Notes
*(uses Obsidian comment `%% lang … %%` style — markers invisible in reading mode and Live Preview)*

%% li8n en %%
Ceremonial-grade matcha is noticeably sweeter and less bitter than culinary-grade. If you only have culinary-grade, reduce the quantity slightly and add a touch more sweetener.
%% endli8n %%

%% li8n zh-CN %%
仪式级抹茶比烹饪级抹茶明显更甜、更不苦涩。如果只有烹饪级抹茶，请稍微减少用量，并适量增加甜味剂。
%% endli8n %%

%% li8n ja %%
儀式用抹茶は料理用抹茶に比べて甘みがあり、苦みが少ないのが特徴です。料理用しかない場合は量を少し減らし、甘味料を少し加えてください。
%% endli8n %%

---

*Serves: 1 | Prep time: 5 minutes*
