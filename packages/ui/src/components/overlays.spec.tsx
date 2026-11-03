import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { Button } from './button';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from './sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

// Radix portals render outside the container, so overlays are checked on document.body.
describe('overlays', () => {
  it('Dialog opens, labels its close button from props, and returns focus on Escape', async () => {
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent closeLabel="Close dialog">
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole('button', { name: 'Open' });

    await userEvent.click(trigger);

    expect(screen.getByRole('dialog', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeInTheDocument();
    await expectNoAxeViolations(document.body);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('Sheet opens from the start edge with no axe violations', async () => {
    render(
      <Sheet>
        <SheetTrigger asChild>
          <Button>Menu</Button>
        </SheetTrigger>
        <SheetContent side="start" closeLabel="Close" aria-describedby={undefined}>
          <SheetTitle>Navigation</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));

    expect(screen.getByRole('dialog', { name: 'Navigation' })).toHaveAttribute(
      'data-side',
      'start',
    );
    await expectNoAxeViolations(document.body);
  });

  it('DropdownMenu opens from the keyboard with no axe violations', async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuItem>Rename</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    screen.getByRole('button', { name: 'Actions' }).focus();
    await userEvent.keyboard('{Enter}');

    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    await expectNoAxeViolations(document.body);
  });

  it('Popover opens with no axe violations', async () => {
    render(
      <Popover>
        <PopoverTrigger asChild>
          <Button>Details</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Details">Popover body</PopoverContent>
      </Popover>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Details' }));

    expect(screen.getByText('Popover body')).toBeInTheDocument();
    await expectNoAxeViolations(document.body);
  });

  it('Tooltip shows on keyboard focus with no axe violations', async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button>Help</Button>
          </TooltipTrigger>
          <TooltipContent>More about this</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    await userEvent.tab();

    expect(await screen.findByRole('tooltip')).toHaveTextContent('More about this');
    await expectNoAxeViolations(document.body);
  });

  it('Command filters as you type', async () => {
    render(
      <Command label="Pages">
        <CommandInput placeholder="Search" />
        <CommandList>
          <CommandEmpty>Nothing found</CommandEmpty>
          <CommandGroup heading="Pages">
            <CommandItem>Home</CommandItem>
            <CommandItem>Design</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );

    // cmdk names its input from the Command label.
    await userEvent.type(screen.getByRole('combobox', { name: 'Pages' }), 'des');

    expect(screen.getByRole('option', { name: 'Design' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Home' })).not.toBeInTheDocument();
  });

  it('CommandDialog leaves no hidden title or description on the page while closed', () => {
    render(
      <CommandDialog open={false} title="Go to" description="Search pages">
        <Command label="Pages">
          <CommandInput />
          <CommandList />
        </Command>
      </CommandDialog>,
    );

    expect(screen.queryByText('Go to')).not.toBeInTheDocument();
    expect(screen.queryByText('Search pages')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('CommandDialog takes its title and description from props', async () => {
    render(
      <CommandDialog open title="Go to" description="Search pages">
        <Command label="Pages">
          <CommandInput />
          <CommandList />
        </Command>
      </CommandDialog>,
    );

    expect(screen.getByRole('dialog', { name: 'Go to' })).toBeInTheDocument();
    await expectNoAxeViolations(document.body);
  });
});
