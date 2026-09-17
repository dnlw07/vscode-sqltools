import React, { useCallback, useState } from 'react';
import Menu from '../../../components/Menu';

export interface IMenuContextState {
  data?: { [key: string]: any };
  options: ({ value: string; label: string } | string)[];
  position: {
    x: number;
    y: number;
  };
  anchorEl: HTMLElement & EventTarget;
}

type IMenuContext = IMenuContextState & {
  // openMenu: (e: React.MouseEvent<HTMLElement>) => void;
  // closeMenu: () => void;
};
export const MenuContext = React.createContext<IMenuContext>(
  {} as IMenuContext
);

const initialState: IMenuContextState = {
  data: {},
  options: [],
  position: {
    x: null,
    y: null,
  },
  anchorEl: null,
};
export const MenuProvider = ({
  children,
  width = 300,
  getOptions,
  onSelect: onSelectProp,
  onOpen,
}: IMenuProviderProps) => {
  const [state, setState] = useState<IMenuContextState>(initialState);
  const { data, options, position, anchorEl } = state;

  // Keep refs to the latest callbacks so openMenu/onSelect never close over
  // stale versions.  Without this, openMenu is created once (when selection
  // is empty) and never sees updated onOpen/getOptions even after selection
  // changes - causing the first right-click to always use the stale closure.
  const getOptionsRef = React.useRef(getOptions);
  const onOpenRef = React.useRef(onOpen);
  const onSelectRef = React.useRef(onSelectProp);
  React.useEffect(() => { getOptionsRef.current = getOptions; }, [getOptions]);
  React.useEffect(() => { onOpenRef.current = onOpen; }, [onOpen]);
  React.useEffect(() => { onSelectRef.current = onSelectProp; }, [onSelectProp]);

  const openMenu = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault();
      // the click target may be a nested element (e.g. header title text) that doesn't
      // itself carry the data-* attributes set by Tabulator on the cell/header/row-header
      const source = (e.target as HTMLElement)?.closest?.('[data-rowindex], [data-colname]') as HTMLElement;
      const dataset = source?.dataset || {};
      const options =
        typeof getOptionsRef.current === 'function'
          ? getOptionsRef.current(dataset, e)
          : [];
      if (!options || options.length === 0) return;
      onOpenRef.current && onOpenRef.current(dataset);
      setState({
        data: dataset,
        options,
        anchorEl: e.currentTarget,
        position: {
          x: e.clientX,
          y: e.clientY,
        },
      });
    },
    [state.anchorEl]
  );

  const closeMenu = useCallback(() => {
    setState(initialState);
  }, []);

  // While our menu is open, MUI's own backdrop sits on top of the table and swallows
  // the next right-click before it ever reaches the Paper's onContextMenu handler below,
  // letting the browser/library default context menu show through instead. Intercept
  // right-clicks at the document level (capture phase, before the backdrop sees them)
  // so a second right-click repositions our own menu instead of opening a different one.
  React.useEffect(() => {
    if (!anchorEl) return undefined;
    const handler = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // e.target here is the invisible backdrop/menu overlay, not the cell under the cursor -
      // briefly make overlays transparent to pointer events so elementFromPoint can find the real cell
      const overlays = Array.from(document.querySelectorAll('.MuiPopover-root, .MuiBackdrop-root')) as HTMLElement[];
      const previousPointerEvents = overlays.map(el => el.style.pointerEvents);
      overlays.forEach(el => { el.style.pointerEvents = 'none'; });
      const realTarget = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement;
      overlays.forEach((el, i) => { el.style.pointerEvents = previousPointerEvents[i]; });

      const source = realTarget?.closest?.('[data-rowindex], [data-colname]') as HTMLElement;
      const dataset = source?.dataset || {};
      const options =
        typeof getOptionsRef.current === 'function'
          ? getOptionsRef.current(dataset, e as any)
          : [];
      if (!options || options.length === 0) {
        setState(initialState);
        return;
      }
      onOpenRef.current && onOpenRef.current(dataset);
      setState({
        data: dataset,
        options,
        anchorEl: realTarget || anchorEl,
        position: {
          x: e.clientX,
          y: e.clientY,
        },
      });
    };
    document.addEventListener('contextmenu', handler, true);
    return () => document.removeEventListener('contextmenu', handler, true);
  }, [anchorEl]);

  const onSelect = useCallback(
    (choice: string) => {
      closeMenu();
      onSelectRef.current && onSelectRef.current(choice, data || {});
    },
    [data, closeMenu]
  );
  return (
    <MenuContext.Provider
      value={{
        data,
        options,
        position,
        anchorEl,
      }}
    >
      {React.cloneElement(children, { onContextMenu: openMenu })}
      <Menu
        anchorEl={anchorEl}
        width={width}
        onClose={closeMenu}
        position={position}
        onSelect={onSelect}
        options={options}
      />
    </MenuContext.Provider>
  );
};

interface IMenuProviderProps {
  children: React.ReactElement<any>;
  width?: number;
  onSelect?: (choice: string, data?: IMenuContextState['data']) => void;
  onOpen?: (data: IMenuContextState['data']) => void;
  getOptions?: (
    data: IMenuContextState['data'],
    e: React.MouseEvent<HTMLElement>
  ) => IMenuContextState['options'];
}
