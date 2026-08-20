import { TrackingRangeDto } from './tracking-range.dto';

/**
 * Un-paginated on purpose: the response is a fixed 24-hour x 7-weekday grid
 * plus its totals, so there is nothing to page through — the shape is the
 * same size whether the window covers a day or a year.
 */
export class WatchTimeQueryDto extends TrackingRangeDto {}
