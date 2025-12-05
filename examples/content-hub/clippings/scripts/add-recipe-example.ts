import { createEpicenterClient } from '@epicenter/hq';
import epicenter from '../../epicenter.config';

await using client = await createEpicenterClient(epicenter);

const result = client.clippings.addRecipe({
	title: 'Cantonese-Style Steamed Fish',
	source: 'https://www.youtube.com/shorts/mimj-PJ20Jo',
	ingredients: `- 2 7oz white fleshed fish fillets (Chilean Sea Bass is my fav)
- Salt
- Shaoxing wine
- 1 large knob ginger
- 5 scallions
- 2 tbsp light soy sauce
- 1.5 tsp sugar
- 1 tsp sesame oil
- 3 tbsp warm water
- 3 tbsp neutral oil`,
	instructions: `1. Season fish with salt and lightly drizzle Chinese cooking wine over the fish.
2. Peel and julienne ginger as thin as possible and slice a few pieces to lay on the bottom of the plate.
3. Cut scallions into 3 inch segments. Save 4-5 segments for the bottom of the plate and thinly slice the rest lengthwise.
4. Add the sliced ginger and scallion segments to the bottom of a plate and place the fish on top.
5. Steam the fish for 10-12 minutes on medium heat while you make the sauce by combining soy sauce, sugar, sesame oil, and water.
6. Remove the fish draining out all of the liquid and add the julienned ginger and scallions on top.
7. Pour the sauce over the fish and heat oil right before it starts to smoke.
8. Pour the hot oil over the aromatics and enjoy with rice.`,
	servings: 2,
	prep_time: '15 min',
	cook_time: '12 min',
});

if (result.error) {
	console.error('Failed to add recipe:', result.error);
} else {
	console.log('✓ Recipe added:', result.data.recipe_id);
}
