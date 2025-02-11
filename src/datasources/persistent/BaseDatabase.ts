import { jsonParse, jsonStringify } from "../../helpers";

export interface HasToString {
  toString(): string;
}

/**
 * This class serves as a base class for all databases that store data in a persistent store.
 *
 * It assumes a key-value store, where the key is a string and the value is a stringified JSON object.
 */
export abstract class BaseDatabase<K extends HasToString, V> {
  /**
   * Gets a value from the store
   */
  protected abstract getFromStore(key: string): Promise<string>;

  /**
   * Puts a key value pair into the store
   */
  protected abstract putToStore(key: string, val: string): Promise<void>;

  /**
   * Fetch data from the source
   */
  protected abstract fetchData(key: K): Promise<V>;

  /**
   * Get a value either from the store or from the source.
   * If the value is fetched from the source, it is also stored in the store.
   * @todo: rename this function for better readability
   */
  async getValue(key: K) {
    try {
      return jsonParse(await this.getFromStore(key.toString())) as V;
    } catch {
      // key is not in store, fetch it and store it
      const data = await this.fetchData(key);
      const stringified = jsonStringify(data);
      await this.putToStore(key.toString(), stringified);
      return data;
    }
  }

  /**
   * Fetch and store a value if it is not already in the store
   * @todo: rename this function for better readability
   */
  protected async fetchAndStore(key: K) {
    await this.getValue(key);
  }
}
