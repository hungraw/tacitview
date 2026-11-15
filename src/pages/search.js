// Search results page for inputs without a dedicated page (address, XNS name, tacit1, asset, ticker).
import { pageHead } from './common.js';
import { renderFootprint } from '../sections/footprint.js';

export const renderSearch = (result) => pageHead({ crumbs: [['Search']], title: 'Search', id: result.query }) + `<section class="card">${renderFootprint(result)}</section>`;
