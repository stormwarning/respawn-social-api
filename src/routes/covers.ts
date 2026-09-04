import { Hono } from 'hono'
import { ensureCoverColors, isValidImageId } from '../derive/colors.js'
import { logger } from '../logger.js'

/**
 * Cover colours.
 *
 * One shared answer per IGDB image id, instead of every user's browser session
 * causing the same image to be fetched and decoded again. Image ids are content
 * addressed — IGDB mints a new one when the art changes — so the result never
 * goes stale and can be cached hard.
 */
export const coversRoutes = new Hono()

coversRoutes.get('/:imageId/colors', async (c) => {
	const imageId = c.req.param('imageId')
	if (!isValidImageId(imageId)) {
		return c.json({ error: 'invalid image id' }, 400)
	}

	try {
		const colors = await ensureCoverColors(imageId)
		if (!colors) {
			// Either IGDB has no such image or it could not be decoded. Cache the
			// miss briefly so a broken cover on a popular page does not mean a
			// fetch attempt per request.
			c.header('Cache-Control', 'public, max-age=600')
			return c.json({ error: 'No colours available for this cover' }, 404)
		}

		// A year: the id changes when the art does, so this answer cannot go
		// stale — only unused.
		c.header('Cache-Control', 'public, max-age=31536000, immutable')
		return c.json({ dominant: colors.dominant, palette: colors.palette })
	} catch (err) {
		logger.error(err, `cover colours failed for ${imageId}`)
		return c.json({ error: 'Failed to read cover colours' }, 500)
	}
})
