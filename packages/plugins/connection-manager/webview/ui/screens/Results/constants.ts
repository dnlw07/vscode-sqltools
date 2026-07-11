export const availableFilterOperations = [
  'contains',
  'equal',
  'notEqual',
  'startsWith',
  'endsWith',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
  'regex',
];

export enum MenuActions {
  FilterByValueOption = 'Filter By {contextAction}',
  ClearFiltersOption = 'Clear All Filters',
  ClearSelection = 'Clear Selection',
  CopyCellOption = 'Copy {contextAction}',
  // CopyRowOption = 'Copy Selected JSON Row(s)',
  CopySelectedCSV = 'Copy Selected as CSV',
  CopySelectedJSON = 'Copy Selected as JSON',
  SaveCSVOption = 'Save Results as CSV',
  SaveJSONOption = 'Save Results as JSON',
  Divider = 'sep',
}