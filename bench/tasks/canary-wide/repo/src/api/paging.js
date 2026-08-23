import { offset, pageCount } from "../reporting/paginate.js";
/** Turn a page request into a database window. */
export function windowFor(page, perPage, totalRows) {
  return { skip: offset(page, perPage), take: perPage, pages: pageCount(totalRows, perPage) };
}
