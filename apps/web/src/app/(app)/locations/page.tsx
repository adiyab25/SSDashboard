import { LocationsPage } from '@/inventory/locations-page';

// Server components render only the shell; locations load in a client component.
export default function Locations() {
  return <LocationsPage />;
}
