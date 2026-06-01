import { Plugin } from 'obsidian';
import { InkBlockRegistry } from './ink/blocks';
import { InkDrawer } from './ink/drawer';

export default class FreeFlowInkPlugin extends Plugin {
	private drawer: InkDrawer | null = null;

	onload(): void {
		this.drawer = new InkDrawer();
		const registry = new InkBlockRegistry(this, this.drawer);
		registry.register();

		this.register(() => {
			this.drawer?.destroy();
			this.drawer = null;
		});
	}
}
